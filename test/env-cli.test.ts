/*
 * `scafo env retire|unretire|delete`, and the two ways it reaches an
 * installation.
 *
 * Both are driven against the same registry: the node route runs the REAL node
 * app over an injected `fetch`, so what these tests exercise is the whole
 * path an operator's command takes — token, route, registry — rather than a
 * stand-in for it. The direct route writes into the same bucket, which is what
 * makes the two comparable at all.
 */

import { generateJWK } from "unjwt/jwk";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { beforeEach, describe, expect, it } from "vitest";
import { setCurrentBuild } from "../src/core/registry/_current.ts";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import {
  nodeOps,
  CLI_NODE_ID,
  describeParkChange,
  describeRetirement,
  describeSelectorChange,
  directOps,
  type EnvironmentOps,
  type ParkFlags,
  readParkFlags,
  readSelectorFlags,
} from "../src/cli/_environments.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import {
  acquireLease,
  createBuild,
  createEnvironment,
  createProject,
  DEFAULT_RETIREMENT_GRACE_MS,
  getEnvironment,
  readJson,
  registerNode,
  retireEnvironment,
} from "../src/core/registry/index.ts";
import { coordinatorKey, environmentKey } from "../src/core/registry/paths.ts";
import type { CoordinatorLease, ParkPolicy } from "../src/core/types/registry.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const NODE_ID = "node-a";
const PROJECT = "app";
const BUILD = "b1b1b1b1";
const OTHER_BUILD = "b2b2b2b2";
const NODE_URL = "http://10.0.0.4:7400";
const HOUR_MS = 3_600_000;

const PROD = { project: PROJECT, env: "prod" };
const PREVIEW = { project: PROJECT, env: "preview" };

let clock: ManualClock;
let keys: { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };
/** Every URL the node transport asked for, in order. */
let called: string[];
/** ONE node for the whole test: a second app would be a second coordinator. */
let daemonOps: EnvironmentOps;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  keys = await generateJWK("EdDSA", { kid: NODE_ID });
  called = [];
  daemonOps = buildNodeOps();

  await registerNode(clock.ctx, {
    v: 1,
    id: NODE_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    addresses: { internal: "10.0.0.4", apiPort: 7400 },
  });
  await createProject(clock.ctx, { slug: PROJECT });
  for (const id of [BUILD, OTHER_BUILD]) {
    await createBuild(clock.ctx, PROJECT, { id, runtimeConfigurable: true });
  }
  await createEnvironment(clock.ctx, PROJECT, { name: "prod" });
  await createEnvironment(clock.ctx, PROJECT, { name: "preview", ephemeral: true });
  await setCurrentBuild(clock.ctx, PROJECT, "prod", BUILD);
});

/* Both transports must answer the same questions the same way, so the retire and
   unretire cases are written once and run against each. */
describe.each([
  ["through a node daemon", (): EnvironmentOps => throughNode()],
  ["straight through the bucket", (): EnvironmentOps => throughBucket()],
])("retiring %s", (_name, build) => {
  it("retires the environment and answers with the record", async () => {
    const environment = await build().retire(PROD);

    expect(environment.retiredAt).toBe(new Date(clock.nowMs()).toISOString());
    expect(await getEnvironment(clock.ctx, PROJECT, "prod")).toEqual(environment);
  });

  it("keeps the first timestamp when it is retired again", async () => {
    const first = await build().retire(PROD);
    clock.tick(HOUR_MS * 6);

    expect((await build().retire(PROD)).retiredAt).toBe(first.retiredAt);
  });

  it("takes it back", async () => {
    await build().retire(PROD);

    const environment = await build().unretire(PROD);

    expect(environment.retiredAt).toBeUndefined();
    expect((await getEnvironment(clock.ctx, PROJECT, "prod")).retiredAt).toBeUndefined();
  });

  it("reports an environment that is not there rather than inventing one", async () => {
    await rejectsWith(() => build().retire({ project: PROJECT, env: "ghost" }), "not-found");
  });
});

/* Choosing which nodes may serve an environment is a plain record update, so it
   goes the same two ways retirement does and must answer identically on both. */
describe.each([
  ["through a node daemon", (): EnvironmentOps => throughNode()],
  ["straight through the bucket", (): EnvironmentOps => throughBucket()],
])("setting a node selector %s", (_name, build) => {
  it("states the labels a node must carry, and answers with the record", async () => {
    const environment = await build().setSelector(PROD, { tier: "fast" });

    expect(environment.nodeSelector).toEqual({ tier: "fast" });
    expect(await getEnvironment(clock.ctx, PROJECT, "prod")).toEqual(environment);
  });

  it("lifts the constraint when it is cleared", async () => {
    await build().setSelector(PROD, { tier: "fast" });

    const environment = await build().setSelector(PROD, null);

    /* The field is gone rather than emptied: the next assignment may use every
       live node again, while an empty object would remain a stated selector. */
    expect("nodeSelector" in environment).toBe(false);
    expect((await getEnvironment(clock.ctx, PROJECT, "prod")).nodeSelector).toBeUndefined();
  });

  it("refuses a selector that is not one, changing nothing", async () => {
    await rejectsWith(() => build().setSelector(PROD, { Tier: "fast" } as never), "invalid-input");

    expect((await getEnvironment(clock.ctx, PROJECT, "prod")).nodeSelector).toBeUndefined();
  });

  it("refuses an empty selector, naming the way to lift a constraint", async () => {
    const error = await rejectsWith(() => build().setSelector(PROD, {}), "invalid-input");

    expect(error.detail).toContain("clear the selector");
  });

  it("reports an environment that is not there rather than inventing one", async () => {
    await rejectsWith(
      () => build().setSelector({ project: PROJECT, env: "ghost" }, { tier: "fast" }),
      "not-found",
    );
  });

  it("takes no coordinator lease to do it", async () => {
    /* Unlike a deletion: there is nothing here two nodes doing it at once could
       corrupt, so neither transport has to become the coordinator. */
    await build().setSelector(PROD, { tier: "fast" });

    const lease = await readJson<CoordinatorLease>(clock.ctx, coordinatorKey());
    expect(lease?.value.node).not.toBe(CLI_NODE_ID);
  });
});

describe("what --set and --clear are read as", () => {
  it("reads the labels of --set", () => {
    expect(readSelectorFlags({ set: "tier=fast,region=eu-west-1", clear: false })).toEqual({
      tier: "fast",
      region: "eu-west-1",
    });
  });

  it("reads --clear as the null that lifts the constraint", () => {
    expect(readSelectorFlags({ set: undefined, clear: true })).toBeNull();
  });

  it("refuses both at once, which say opposite things", async () => {
    const error = await rejectsWith(
      () => Promise.resolve(readSelectorFlags({ set: "tier=fast", clear: true })),
      "invalid-input",
    );

    expect(error.detail).toContain("opposite");
  });

  it("refuses NEITHER rather than reading it as a clear", async () => {
    /* An accidental `scafo env selector` that lifted a constraint would move an
       application across a fleet without anyone having asked it to. */
    const error = await rejectsWith(
      () => Promise.resolve(readSelectorFlags({ set: undefined, clear: false })),
      "invalid-input",
    );

    expect(error.detail).toContain("--set");
    expect(error.detail).toContain("--clear");
  });

  it("refuses labels it cannot read, before any node is troubled with them", async () => {
    const error = await rejectsWith(
      () => Promise.resolve(readSelectorFlags({ set: "tier", clear: false })),
      "invalid-input",
    );

    expect(error.detail).toContain("--set");
  });
});

/* Saying how an environment scales to zero is a plain record update too, so it
   goes the same two ways and must answer identically on both. */
describe.each([
  ["through a node daemon", (): EnvironmentOps => throughNode()],
  ["straight through the bucket", (): EnvironmentOps => throughBucket()],
])("stating a park policy %s", (_name, build) => {
  it("stores the fields it was given, and answers with the record", async () => {
    const environment = await build().setPark(PREVIEW, { afterS: 60, wakeDeadlineS: 5 });

    /* Only what the operator decided: every blank falls back to what the
       environment's kind implies, and writing a resolved default into the
       record would freeze today's default into an environment that never asked. */
    expect(environment.park).toEqual({ afterS: 60, wakeDeadlineS: 5 });
    expect(await getEnvironment(clock.ctx, PROJECT, "preview")).toEqual(environment);
  });

  it("falls back to what its kind implies when it is cleared", async () => {
    await build().setPark(PREVIEW, { afterS: 60 });

    const environment = await build().setPark(PREVIEW, null);

    /* The field is gone rather than emptied: readers ask what an environment
       with no policy of its own implies, and a `{}` would be a policy saying
       nothing. */
    expect("park" in environment).toBe(false);
    expect((await getEnvironment(clock.ctx, PROJECT, "preview")).park).toBeUndefined();
  });

  it("relays the registry's refusal of a window on a long-lived environment", async () => {
    const error = await rejectsWith(() => build().setPark(PROD, { afterS: 60 }), "invalid-input");

    /* Verbatim, whichever way the operator reached the installation: the rule is
       the registry's and the wording must not depend on the transport. */
    expect(error.detail).toContain("live traffic");
    expect((await getEnvironment(clock.ctx, PROJECT, "prod")).park).toBeUndefined();
  });

  it("reports an environment that is not there rather than inventing one", async () => {
    await rejectsWith(
      () => build().setPark({ project: PROJECT, env: "ghost" }, { afterS: 60 }),
      "not-found",
    );
  });

  it("takes no coordinator lease to do it", async () => {
    await build().setPark(PREVIEW, { afterS: 60 });

    const lease = await readJson<CoordinatorLease>(clock.ctx, coordinatorKey());
    expect(lease?.value.node).not.toBe(CLI_NODE_ID);
  });
});

describe("what the park flags are read as", () => {
  it("reads only the fields that were given", () => {
    expect(
      readParkFlags({
        after: "60",
        wakeDeadline: "5",
        clear: false,
      }),
    ).toEqual({ afterS: 60, wakeDeadlineS: 5 });

    expect(parkFlags({ after: "0" })).toEqual({ afterS: 0 });
  });

  it("reads --clear as the null that falls back to what the kind implies", () => {
    expect(parkFlags({ clear: true })).toBeNull();
  });

  it.each(["after", "wakeDeadline"] as const)(
    "refuses --clear beside %s, which say opposite things",
    async (field) => {
      const error = await rejectsWith(
        () => Promise.resolve(parkFlags({ [field]: "60", clear: true })),
        "invalid-input",
      );

      expect(error.detail).toContain("opposite");
      expect(error.detail).toContain("--clear");
    },
  );

  it("refuses NEITHER rather than reading it as a clear", async () => {
    /* An accidental `scafo env park` that lifted a policy would put a whole
       preview fleet back to running around the clock. */
    const error = await rejectsWith(() => Promise.resolve(parkFlags({})), "invalid-input");

    expect(error.detail).toContain("--after");
    expect(error.detail).toContain("--clear");
  });

  it("refuses seconds that are not a whole number, before any node is troubled", async () => {
    for (const [flag, stated] of [
      ["after", "1.5"],
      ["after", "-60"],
      ["after", "a while"],
      ["wakeDeadline", "-1"],
    ] as const) {
      const error = await rejectsWith(
        () => Promise.resolve(parkFlags({ [flag]: stated })),
        "invalid-input",
      );
      expect(error.detail, `${flag} "${stated}"`).toContain("whole number of seconds");
    }
  });
});

describe("deleting through a node daemon", () => {
  it("refuses a long-lived environment, relaying the grace the node named", async () => {
    const error = await rejectsWith(() => throughNode().delete(PROD), "invalid-input");

    /*
     * The refusal survives the wire intact, which is the point of relaying the
     * node's problem document rather than summarising it: what reaches the
     * operator is the route forward, not "the node said no".
     */
    expect(error.status).toBe(409);
    expect(error.detail).toContain("scafo env retire");
    expect(error.detail).toContain("force");
  });

  it("says how long is left once it has been retired", async () => {
    await throughNode().retire(PROD);
    clock.tick(HOUR_MS * 6);

    const error = await rejectsWith(() => throughNode().delete(PROD), "invalid-input");

    expect(error.detail).toContain("18h");
    expect(error.detail).toContain("scafo env unretire");
  });

  it("deletes it once the grace has run out", async () => {
    await throughNode().retire(PROD);
    clock.tick(DEFAULT_RETIREMENT_GRACE_MS);

    const deleted = await throughNode().delete(PROD);

    expect(deleted).toContain(environmentKey(PROJECT, "prod"));
    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "prod"), "not-found");
  });

  it("asks for the force the operator asked for, and only then", async () => {
    await throughNode().delete(PREVIEW);
    expect(called.at(-1)).toBe(`${NODE_URL}/v1/environments/${PROJECT}/preview`);

    const deleted = await throughNode().delete(PROD, { force: true });

    /* `--force` has to reach the node as a query the node reads; a flag the
       client swallowed would refuse a deletion the operator did state. */
    expect(called.at(-1)).toBe(`${NODE_URL}/v1/environments/${PROJECT}/prod?force=1`);
    expect(deleted).toContain(environmentKey(PROJECT, "prod"));
  });

  it("refuses a name that is not a slug before any node is troubled with it", async () => {
    await rejectsWith(
      () => throughNode().retire({ project: PROJECT, env: "../../etc" }),
      "invalid-slug",
    );

    expect(called).toEqual([]);
  });
});

describe("deleting straight through the bucket", () => {
  it("takes the lease, deletes, and hands it straight back", async () => {
    const deleted = await throughBucket().delete(PREVIEW);

    expect(deleted).toContain(environmentKey(PROJECT, "preview"));
    /*
     * Released rather than left to expire: the CLI has to BE the coordinator
     * for the length of a deletion, and an installation whose coordinator is a
     * laptop that has already exited would sit out the whole TTL before a node
     * took the work back.
     */
    const lease = await readJson<CoordinatorLease>(clock.ctx, coordinatorKey());
    expect(lease?.value.node).toBe(CLI_NODE_ID);
    expect(lease?.value.ttlMs).toBe(0);
  });

  it("hands the lease back even when the deletion was refused", async () => {
    await rejectsWith(() => throughBucket().delete(PROD), "invalid-input");

    const lease = await readJson<CoordinatorLease>(clock.ctx, coordinatorKey());
    expect(lease?.value.ttlMs).toBe(0);
  });

  it("forces past the two steps when the operator says so", async () => {
    const deleted = await throughBucket().delete(PROD, { force: true });

    expect(deleted).toContain(environmentKey(PROJECT, "prod"));
  });

  it("refuses while a live node is coordinating, and sends the operator there", async () => {
    expect(await acquireLease(clock.ctx, NODE_ID)).not.toBeNull();

    const error = await rejectsWith(() => throughBucket().delete(PREVIEW), "lease-lost");

    /* A node holds the lease, so the request belongs to the node: it will reach
       the coordinator wherever it is, without disturbing the election. */
    expect(error.detail).toContain("--node");
    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      name: "preview",
    });
  });

  it("goes ahead once the node's lease has expired under it", async () => {
    expect(await acquireLease(clock.ctx, NODE_ID, { ttlMs: 1000 })).not.toBeNull();
    clock.tick(HOUR_MS);

    /* An expired lease is a record nobody stands behind; taking it over is
       exactly what any surviving node would do. */
    expect(await throughBucket().delete(PREVIEW)).toContain(environmentKey(PROJECT, "preview"));
  });
});

describe("what the command puts on the terminal", () => {
  it("names the two things an operator does next", async () => {
    const environment = await retireEnvironment(clock.ctx, PROJECT, "prod");

    const printed = describeRetirement(PROD, environment);

    expect(printed).toContain(environment.retiredAt as string);
    expect(printed).toContain("unretire");
    expect(printed).toContain("deleted");
  });

  it("says plainly when there was nothing to retire", async () => {
    const environment = await getEnvironment(clock.ctx, PROJECT, "prod");

    expect(describeRetirement(PROD, environment)).toContain("is not retired");
  });

  it("names the labels a selector now asks for, and who acts on them", async () => {
    const environment = await throughBucket().setSelector(PROD, { tier: "fast" });

    const printed = describeSelectorChange(PROD, environment);

    expect(printed).toContain("tier=fast");
    /* Stating the intent is not placing it: the coordinator does that, and the
       operator has to know that is what they are waiting for. */
    expect(printed).toContain("coordinator");
  });

  it("says what a cleared selector means, rather than saying nothing", async () => {
    const environment = await throughBucket().setSelector(PROD, null);

    expect(describeSelectorChange(PROD, environment)).toContain("no nodes any more");
  });

  it("names the WHOLE resolved policy, not only the field that just changed", async () => {
    const environment = await throughBucket().setPark(PREVIEW, { wakeDeadlineS: 45 });

    const printed = describeParkChange(PREVIEW, environment);

    /* An operator who set one field still has to see what the others resolved
       to, because that is what the environment will actually do. */
    expect(printed).toContain("parks 900s after its last wake");
    expect(printed).toContain("45s");
  });

  it("says a long-lived environment never parks on a clock, whatever was just set", async () => {
    const environment = await getEnvironment(clock.ctx, PROJECT, "prod");

    /* The case that surprises people most, and the reason the printed line is
       the resolved policy rather than the fields that were written. */
    expect(describeParkChange(PROD, environment)).toContain("never parks on a clock");
  });

  it("says when an environment carries no policy of its own", async () => {
    const environment = await getEnvironment(clock.ctx, PROJECT, "preview");

    const printed = describeParkChange(PREVIEW, environment);

    expect(printed).toContain("no park policy of its own");
    expect(printed).toContain("parks 900s after its last wake");
  });
});

/* ------------------------------------------------------------------ helpers */

/** One `scafo env park` invocation: the flags it stated, and no others. */
function parkFlags(given: Partial<ParkFlags>): ParkPolicy | null {
  return readParkFlags({
    after: undefined,
    wakeDeadline: undefined,
    clear: false,
    ...given,
  });
}

/** The one node this test talks to, as the CLI's node transport sees it. */
function throughNode(): EnvironmentOps {
  return daemonOps;
}

/** The CLI talking to a REAL node app over an injected `fetch`. */
function buildNodeOps(): EnvironmentOps {
  const app = createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    version: "0.0.0-test",
    /* The app deletes through the lease it holds; without a coordinator loop it
       would only ever forward, which is a different test. */
    coordinator: soleCoordinator(),
  });

  return nodeOps({
    url: NODE_URL,
    authorize: () => signNodeToken(keys.privateKey, NODE_ID),
    fetchFn: async (input, init) => {
      const url = String(input);
      called.push(url);
      /* The app may answer synchronously; `fetch` never does. */
      return app.request(url, init);
    },
  });
}

/** The CLI writing into the bucket itself, with no node in the picture. */
function throughBucket(): EnvironmentOps {
  return directOps(clock.ctx);
}

/**
 * A coordinator that simply holds the lease, which is all the delete route asks
 * of one: it takes the lease on the first call and answers with the handle that
 * fences every write made under it.
 */
function soleCoordinator(): NonNullable<Parameters<typeof createNodeApp>[0]["coordinator"]> {
  let held: Awaited<ReturnType<typeof acquireLease>> = null;

  return {
    start: () => {},
    stop: () => Promise.resolve(),
    async runOnce(): Promise<void> {
      held = await acquireLease(clock.ctx, NODE_ID);
    },
    status: () => ({
      holding: held !== null,
      lease: held?.lease ?? null,
      lastReapAt: null,
      lastReapFailure: null,
      lastAssignAt: null,
      lastAssignment: null,
      lastAssignFailure: null,
    }),
    handle: () => held,
  };
}

function daemonConfig(): DaemonConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: NODE_ID, listen: "127.0.0.1:7400" },
    platformDomains: ["apps.test"],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      probePath: "/",
      bindHost: "127.0.0.1",
      durability: "bucket",
      cellIdleEvictS: 900,
      pointerHoldMs: 3_000,
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
  };
}

/** Runs nothing: none of these routes touches the supervisor. */
function idleSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: () => [],
    onExit: () => {},
  };
}
