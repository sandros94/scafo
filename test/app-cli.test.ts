/*
 * `scafo app`: the whole group, over each way it reaches an installation.
 *
 * The admin verbs — list, show, block, unblock, label — go through a NODE on the
 * authority of an operator key. The rest also write straight into the bucket
 * when no node is named, so retire, unretire, selector, replicas and delete are
 * exercised over both.
 */

import { type ArgsDef, type CommandDef, parseArgs } from "citty";
import { generateJWK } from "unjwt/jwk";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ApplicationApi,
  applicationApi,
  type ApplicationOps,
  CLI_NODE_ID,
  describeReplicasChange,
  describeRetirement,
  describeSelectorChange,
  directOps,
  formatApplication,
  formatApplicationTable,
  nodeOps,
  readLabelArgs,
  readSelectorFlags,
} from "../src/cli/_applications.ts";
import { app as appCommand } from "../src/cli/commands/app.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import { recordRevision } from "../src/core/registry/_revision.ts";
import {
  acquireLease,
  applicationKey,
  coordinatorKey,
  createApplication,
  createDeployment,
  DEFAULT_RETIREMENT_GRACE_MS,
  getApplication,
  readJson,
  registerNode,
  retireApplication,
} from "../src/core/registry/index.ts";
import { type OperatorRole, trustOperator } from "../src/core/registry/operators.ts";
import type { ApplicationRecord, CoordinatorLease } from "../src/core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { createNodeApp } from "../src/daemon/app.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import {
  ctxWith,
  type ManualClock,
  rejectionOf,
  rejectsWith,
  TEST_VERSIONS,
  urlOf,
} from "./_helpers.ts";

const NODE_ID = "node-a";
const NODE_URL = "http://10.0.0.4:7400";
const ADMIN_ID = "op-aaaa1111";
const TENANT_ID = "op-bbbb2222";
const HOUR_MS = 3_600_000;

/** The application the tenant key reaches, and the one it does not. */
const MINE = "acme";
const THEIRS = "zenith";
/** `--name acme --env preview` addresses this one, and it is already on its way out. */
const PREVIEW = "acme-preview";

const VERSION = "b1b1b1b1";
const OTHER_VERSION = "b2b2b2b2";

type Keypair = { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };

let clock: ManualClock;
let node: Keypair;
let admin: Keypair;
let tenant: Keypair;
/** Every URL the node transport asked for, in order. */
let called: string[];
/** The admin surface as an ADMIN of the fleet reaches it. */
let asAdmin: ApplicationApi;
/** The same, as an operator-tier key scoped to {@link MINE}. */
let asTenant: ApplicationApi;
/** One node for the whole test: a second app would be a second coordinator. */
let daemonOps: ApplicationOps;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  node = await generateJWK("EdDSA", { kid: NODE_ID });
  admin = await generateJWK("EdDSA", { kid: ADMIN_ID });
  tenant = await generateJWK("EdDSA", { kid: TENANT_ID });
  called = [];

  await registerNode(clock.ctx, {
    v: 1,
    id: NODE_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: node.publicKey.x },
    addresses: { internal: "10.0.0.4", apiPort: 7400 },
  });
  await trust(ADMIN_ID, admin, "admin");
  await trust(TENANT_ID, tenant, "operator", [MINE]);
  for (const name of [MINE, PREVIEW, THEIRS]) await createApplication(clock.ctx, { name });
  for (const version of [VERSION, OTHER_VERSION]) {
    await createDeployment(clock.ctx, MINE, { version });
  }
  await recordRevision(clock.ctx, MINE, VERSION);
  /* Preview stands for the application an operator has already decided to be rid
     of: retired, and past its grace, so a plain delete may act on it. */
  await retireApplication(clock.ctx, PREVIEW);
  clock.tick(DEFAULT_RETIREMENT_GRACE_MS);

  const served = buildApp();
  daemonOps = buildNodeOps(served);
  asAdmin = reach(served, ADMIN_ID, admin);
  asTenant = reach(served, TENANT_ID, tenant);
});

describe("scafo app list", () => {
  it("shows an admin every application, with the blocked ones marked", async () => {
    await asAdmin.block(THEIRS);

    const listing = await asAdmin.list();

    expect(listing.applications.map((entry) => entry.name)).toEqual([MINE, PREVIEW, THEIRS]);
    expect(listing.scoped).toBeUndefined();
    const table = formatApplicationTable(listing);
    expect(table).toContain("3 applications, 1 blocked");
    expect(table).toMatch(new RegExp(`${THEIRS}\\s+blocked`));
    expect(table).toMatch(new RegExp(`${MINE}\\s+serving`));
    expect(table).toMatch(new RegExp(`${PREVIEW}\\s+retired`));
  });

  it("shows a scoped key only what it reaches, and SAYS the answer is narrowed", async () => {
    const listing = await asTenant.list();

    expect(listing.applications.map((entry) => entry.name)).toEqual([MINE]);
    expect(listing.scoped).toBe(true);

    /*
     * The header has to say it. A filtered listing and a whole one are the same
     * shape, so a tenant reading an unmarked one would conclude the fleet has
     * exactly one application — and, worse, that it has seen all of it.
     */
    const table = formatApplicationTable(listing);
    expect(table).toContain("the applications this key reaches");
    expect(table).not.toContain(THEIRS);
  });

  it("says so plainly when there is nothing to show", () => {
    expect(formatApplicationTable({ applications: [] })).toContain("no application here");
    expect(formatApplicationTable({ applications: [], scoped: true })).toContain(
      "no application here that this key reaches",
    );
  });
});

describe("scafo app show", () => {
  it("names the state, the deployment, the placement and the labels", async () => {
    await asAdmin.setLabels(MINE, { tenant: "acme" });

    const shown = formatApplication(await asAdmin.show(MINE));

    expect(shown).toContain(`application "${MINE}"`);
    expect(shown).toContain("serving");
    expect(shown).toContain("revision 1");
    /* Defaults are printed as the values they are, so an application nobody has
       placed reads the same way as one somebody has. */
    expect(shown).toContain("replicas    all");
    expect(shown).toContain("selector    -");
    expect(shown).toContain("domains     -");
    expect(shown).toContain("tenant=acme");
  });

  it("prints the way back out of a retirement and out of a block", async () => {
    const retired = formatApplication(await asAdmin.show(PREVIEW));

    expect(retired).toContain("Retired at");
    expect(retired).toContain(`scafo app unretire --name`);

    const blocked = formatApplication(await asAdmin.block(MINE));

    expect(blocked).toContain("blocked");
    expect(blocked).toContain(`scafo app unblock --name ${MINE}`);
  });

  it("answers --json with the record itself rather than a rendering of it", async () => {
    const record = await asAdmin.show(MINE);

    expect(showJson(record)).toEqual(record);
    /* Declared, because the rendering above is only reachable through the flag. */
    expect(subCommand("show").args).toHaveProperty("json");
  });

  it("shows a scoped key its own application without the fleet's labels", async () => {
    await asAdmin.setLabels(MINE, { account: "acct-4417" });

    const seen = await asTenant.show(MINE);

    expect(seen).not.toHaveProperty("labels");
    expect(formatApplication(seen)).not.toContain("acct-4417");
    await rejectsWith(() => asTenant.show(THEIRS), "auth-scope");
  });
});

describe("scafo app block", () => {
  it("blocks for an admin and takes it back, both idempotently", async () => {
    await expect(asAdmin.block(MINE)).resolves.toMatchObject({ blocked: true });
    await expect(asAdmin.block(MINE)).resolves.toMatchObject({ blocked: true });
    await expect(getApplication(clock.ctx, MINE)).resolves.toMatchObject({ blocked: true });

    await expect(asAdmin.unblock(MINE)).resolves.not.toHaveProperty("blocked");
    await expect(asAdmin.unblock(MINE)).resolves.not.toHaveProperty("blocked");
    await expect(getApplication(clock.ctx, MINE)).resolves.not.toHaveProperty("blocked");
  });

  it("REFUSES an operator-tier key on its own application", async () => {
    const error = await rejectsWith(() => asTenant.block(MINE), "auth-scope");

    expect(error.detail).toContain("admin");
    await expect(getApplication(clock.ctx, MINE)).resolves.not.toHaveProperty("blocked");
  });

  it("refuses it on somebody else's with the ordinary out-of-scope answer", async () => {
    /* Not the tier refusal: a key that does not reach the application must not
       learn that blocking is a thing that could be done to it. */
    await rejectsWith(() => asTenant.block(THEIRS), "auth-scope");
    await expect(getApplication(clock.ctx, THEIRS)).resolves.not.toHaveProperty("blocked");
  });

  it("refuses a name that could never name an application, before any call is made", async () => {
    expect((await rejectionOf(() => asAdmin.block("Not A Name"))).code).toBe("invalid-slug");
  });

  it("answers not-found for an application this fleet does not hold", async () => {
    expect((await rejectionOf(() => asAdmin.block("nothing-here"))).code).toBe("not-found");
  });
});

describe("scafo app label", () => {
  it("replaces the whole map, and clears it when no pair is given", async () => {
    await asAdmin.setLabels(MINE, readLabelArgs(["tenant=acme", "plan=pro"]));
    await expect(getApplication(clock.ctx, MINE)).resolves.toMatchObject({
      labels: { tenant: "acme", plan: "pro" },
    });

    await asAdmin.setLabels(MINE, readLabelArgs(["tenant=acme"]));
    await expect(getApplication(clock.ctx, MINE)).resolves.toMatchObject({
      labels: { tenant: "acme" },
    });

    await asAdmin.setLabels(MINE, readLabelArgs([]));
    await expect(getApplication(clock.ctx, MINE)).resolves.not.toHaveProperty("labels");
  });

  it("reads the pairs off the positionals citty left them in", () => {
    const flags = parseArgs(
      ["--name", MINE, "tenant=acme", "plan=pro"],
      subCommand("label").args as never,
    ) as Record<string, unknown>;

    expect(flags.name).toBe(MINE);
    expect(readLabelArgs(flags._ as string[])).toEqual({ tenant: "acme", plan: "pro" });
    expect(
      readLabelArgs(
        (parseArgs(["--name", MINE], subCommand("label").args as never) as Record<string, unknown>)
          ._ as string[],
      ),
    ).toEqual({});
  });

  it("keeps a value that carries its own separators", () => {
    /* Split on the first "=" alone: a value is free text as far as scafo is
       concerned, and a downstream billing id is exactly the kind of thing that
       carries one. */
    expect(readLabelArgs(["url=https://x.test/a=b"])).toEqual({ url: "https://x.test/a=b" });
  });

  it("refuses anything that is not a pair, before any call is made", async () => {
    for (const bad of ["justakey", "=novalue"]) {
      const error = await rejectsWith(() => Promise.resolve(readLabelArgs([bad])), "invalid-input");
      /* Names the pair that was wrong and the shape it should have had: an
         operator who mistyped one label of five needs to know which. */
      expect(error.detail).toContain(bad);
      expect(error.detail).toContain("key=value");
    }
  });

  it("REFUSES an operator-tier key", async () => {
    await rejectsWith(() => asTenant.setLabels(MINE, { tenant: "acme" }), "auth-scope");
    await expect(getApplication(clock.ctx, MINE)).resolves.not.toHaveProperty("labels");
  });

  it("does not show them to an operator-tier key either, on its own application", async () => {
    await asAdmin.setLabels(MINE, { account: "acct-4417" });

    const listing = await asTenant.list();

    /* The read side matches the write side: labels are the fleet's notes about a
       tenant, so they neither leave through the API nor reach the terminal. */
    expect(listing.applications[0]).not.toHaveProperty("labels");
    expect(formatApplicationTable(listing)).not.toContain("acct-4417");

    /* And the admin who wrote them still reads them back. */
    const mine = (await asAdmin.list()).applications.find((entry) => entry.name === MINE);
    expect(formatApplicationTable({ applications: [mine as ApplicationRecord] })).toContain(
      "account=acct-4417",
    );
  });
});

describe.each([
  ["through a node daemon", (): ApplicationOps => throughNode()],
  ["straight through the bucket", (): ApplicationOps => throughBucket()],
])("retiring %s", (_name, build) => {
  it("retires the application and answers with the record", async () => {
    const application = await build().retire(MINE);

    expect(application.retiredAt).toBe(new Date(clock.nowMs()).toISOString());
    expect(await getApplication(clock.ctx, MINE)).toEqual(application);
  });

  it("keeps the first timestamp when it is retired again", async () => {
    const first = await build().retire(MINE);
    clock.tick(HOUR_MS * 6);

    expect((await build().retire(MINE)).retiredAt).toBe(first.retiredAt);
  });

  it("takes it back", async () => {
    await build().retire(MINE);

    const application = await build().unretire(MINE);

    expect(application.retiredAt).toBeUndefined();
    expect((await getApplication(clock.ctx, MINE)).retiredAt).toBeUndefined();
  });

  it("reports an application that is not there rather than inventing one", async () => {
    expect((await rejectionOf(() => build().retire("ghost"))).code).toBe("not-found");
  });
});

describe.each([
  ["through a node daemon", (): ApplicationOps => throughNode()],
  ["straight through the bucket", (): ApplicationOps => throughBucket()],
])("setting a node selector %s", (_name, build) => {
  it("states the labels a node must carry, and answers with the record", async () => {
    const application = await build().setSelector(MINE, { tier: "fast" });

    expect(application.nodeSelector).toEqual({ tier: "fast" });
    expect(await getApplication(clock.ctx, MINE)).toEqual(application);
  });

  it("lifts the constraint when it is cleared", async () => {
    await build().setSelector(MINE, { tier: "fast" });

    const application = await build().setSelector(MINE, null);

    expect("nodeSelector" in application).toBe(false);
    expect((await getApplication(clock.ctx, MINE)).nodeSelector).toBeUndefined();
  });

  it("refuses a selector that is not one, changing nothing", async () => {
    await rejectsWith(() => build().setSelector(MINE, { Tier: "fast" } as never), "invalid-input");

    expect((await getApplication(clock.ctx, MINE)).nodeSelector).toBeUndefined();
  });

  it("refuses an empty selector, naming the way to lift a constraint", async () => {
    const error = await rejectsWith(() => build().setSelector(MINE, {}), "invalid-input");

    expect(error.detail).toContain("clear the selector");
  });

  it("reports an application that is not there rather than inventing one", async () => {
    const error = await rejectionOf(() => build().setSelector("ghost", { tier: "fast" }));

    expect(error.code).toBe("not-found");
  });

  it("takes no coordinator lease to do it", async () => {
    await build().setSelector(MINE, { tier: "fast" });

    const lease = await readJson<CoordinatorLease>(clock.ctx, coordinatorKey());
    expect(lease?.value.node).not.toBe(CLI_NODE_ID);
  });
});

describe.each([
  ["through a node daemon", (): ApplicationOps => throughNode()],
  ["straight through the bucket", (): ApplicationOps => throughBucket()],
])("setting how many nodes serve it %s", (_name, build) => {
  it("states the count, and answers with the record", async () => {
    const application = await build().setReplicas(MINE, 2);

    expect(application.replicas).toBe(2);
    expect(await getApplication(clock.ctx, MINE)).toEqual(application);
  });

  it('takes "all" back to every eligible node', async () => {
    await build().setReplicas(MINE, 3);

    const application = await build().setReplicas(MINE, "all");

    /* Stored as the default it is rather than as a number, so an installation
       that never asked for a count keeps reading as one that never asked. */
    expect(application.replicas).toBe("all");
  });

  it("refuses a count that is not one, changing nothing", async () => {
    await rejectsWith(() => build().setReplicas(MINE, 0 as never), "invalid-input");

    expect((await getApplication(clock.ctx, MINE)).replicas).toBeUndefined();
  });

  it("reports an application that is not there rather than inventing one", async () => {
    expect((await rejectionOf(() => build().setReplicas("ghost", 2))).code).toBe("not-found");
  });
});

describe("what --set and --clear are read as", () => {
  it("reads one label per --set, and every occurrence of it", () => {
    expect(readSelectorFlags({ set: ["tier=fast", "region=eu-west-1"], clear: false })).toEqual({
      tier: "fast",
      region: "eu-west-1",
    });
  });

  it("reads --clear as the null that lifts the constraint", () => {
    expect(readSelectorFlags({ set: [], clear: true })).toBeNull();
  });

  it("refuses both at once, which say opposite things", async () => {
    const error = await rejectsWith(
      () => Promise.resolve(readSelectorFlags({ set: ["tier=fast"], clear: true })),
      "invalid-input",
    );

    expect(error.detail).toContain("opposite");
  });

  it("refuses NEITHER rather than reading it as a clear", async () => {
    const error = await rejectsWith(
      () => Promise.resolve(readSelectorFlags({ set: [], clear: false })),
      "invalid-input",
    );

    expect(error.detail).toContain("--set");
    expect(error.detail).toContain("--clear");
  });

  it("refuses labels it cannot read, before any node is troubled with them", async () => {
    const error = await rejectsWith(
      () => Promise.resolve(readSelectorFlags({ set: ["tier"], clear: false })),
      "invalid-input",
    );

    expect(error.detail).toContain("--set");
  });
});

describe("deleting through a node daemon", () => {
  it("refuses a long-lived application, relaying the grace the node named", async () => {
    const error = await rejectsWith(() => throughNode().delete(MINE), "invalid-input");

    expect(error.status).toBe(409);
    expect(error.detail).toContain("scafo app retire");
    expect(error.detail).toContain("force");
  });

  it("says how long is left once it has been retired", async () => {
    await throughNode().retire(MINE);
    clock.tick(HOUR_MS * 6);

    const error = await rejectsWith(() => throughNode().delete(MINE), "invalid-input");

    expect(error.detail).toContain("18h");
    expect(error.detail).toContain("scafo app unretire");
  });

  it("deletes it once the grace has run out", async () => {
    await throughNode().retire(MINE);
    clock.tick(DEFAULT_RETIREMENT_GRACE_MS);

    const deleted = await throughNode().delete(MINE);

    expect(deleted).toContain(applicationKey(MINE));
    await rejectsWith(() => getApplication(clock.ctx, MINE), "not-found");
  });

  it("asks for the force the operator asked for, and only then", async () => {
    await throughNode().delete(PREVIEW);
    expect(called.at(-1)).toBe(`${NODE_URL}/v1/applications/${PREVIEW}`);

    const deleted = await throughNode().delete(MINE, { force: true });

    expect(called.at(-1)).toBe(`${NODE_URL}/v1/applications/${MINE}?force=1`);
    expect(deleted).toContain(applicationKey(MINE));
  });

  it("refuses a name that is not one before any node is troubled with it", async () => {
    await rejectsWith(() => throughNode().retire("../../etc"), "invalid-slug");

    expect(called).toEqual([]);
  });
});

describe("deleting straight through the bucket", () => {
  it("takes the lease, deletes, and hands it straight back", async () => {
    const deleted = await throughBucket().delete(PREVIEW);

    expect(deleted).toContain(applicationKey(PREVIEW));
    const lease = await readJson<CoordinatorLease>(clock.ctx, coordinatorKey());
    expect(lease?.value.node).toBe(CLI_NODE_ID);
    expect(lease?.value.ttlMs).toBe(0);
  });

  it("hands the lease back even when the deletion was refused", async () => {
    await rejectsWith(() => throughBucket().delete(MINE), "invalid-input");

    const lease = await readJson<CoordinatorLease>(clock.ctx, coordinatorKey());
    expect(lease?.value.ttlMs).toBe(0);
  });

  it("forces past the two steps when the operator says so", async () => {
    const deleted = await throughBucket().delete(MINE, { force: true });

    expect(deleted).toContain(applicationKey(MINE));
  });

  it("refuses while a live node is coordinating, and sends the operator there", async () => {
    expect(await acquireLease(clock.ctx, NODE_ID)).not.toBeNull();

    const error = await rejectsWith(() => throughBucket().delete(PREVIEW), "lease-lost");

    expect(error.detail).toContain("--node");
    await expect(getApplication(clock.ctx, PREVIEW)).resolves.toMatchObject({ name: PREVIEW });
  });

  it("goes ahead once the node's lease has expired under it", async () => {
    expect(await acquireLease(clock.ctx, NODE_ID, { ttlMs: 1000 })).not.toBeNull();
    clock.tick(HOUR_MS);

    expect(await throughBucket().delete(PREVIEW)).toContain(applicationKey(PREVIEW));
  });
});

describe("what the command puts on the terminal", () => {
  it("names the two things an operator does next, and says when there was nothing to retire", async () => {
    const standing = await getApplication(clock.ctx, MINE);
    expect(describeRetirement(MINE, standing)).toContain("is not retired");

    const application = await retireApplication(clock.ctx, MINE);

    const printed = describeRetirement(MINE, application);

    expect(printed).toContain(application.retiredAt as string);
    expect(printed).toContain("unretire");
    expect(printed).toContain("deleted");
  });

  it("names the labels a selector now asks for and who acts on them, and what clearing it means", async () => {
    const application = await throughBucket().setSelector(MINE, { tier: "fast" });

    const printed = describeSelectorChange(MINE, application);

    expect(printed).toContain("tier=fast");
    expect(printed).toContain("coordinator");

    const cleared = await throughBucket().setSelector(MINE, null);

    expect(describeSelectorChange(MINE, cleared)).toContain("no nodes any more");
  });

  it("names how many nodes a count asks for, and who decides which", async () => {
    const one = await throughBucket().setReplicas(MINE, 1);
    expect(describeReplicasChange(MINE, one)).toContain("1 node");

    const two = await throughBucket().setReplicas(MINE, 2);
    expect(describeReplicasChange(MINE, two)).toContain("2 nodes");
    expect(describeReplicasChange(MINE, two)).toContain("coordinator");

    const every = await throughBucket().setReplicas(MINE, "all");
    expect(describeReplicasChange(MINE, every)).toContain("every eligible node");
  });
});

/** The one node this test talks to, as the CLI's node transport sees it. */
function throughNode(): ApplicationOps {
  return daemonOps;
}

/** The CLI writing into the bucket itself, with no node in the picture. */
function throughBucket(): ApplicationOps {
  return directOps(clock.ctx);
}

/** What `scafo app show --json` prints, read back. */
function showJson(record: ApplicationRecord): unknown {
  return JSON.parse(JSON.stringify(record, null, 2));
}

function subCommand(name: string): CommandDef & { args: ArgsDef } {
  const found = (appCommand.subCommands as Record<string, CommandDef>)[name];
  return found as CommandDef & { args: ArgsDef };
}

function buildApp(): ReturnType<typeof createNodeApp> {
  return createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    versions: TEST_VERSIONS,
    coordinator: soleCoordinator(),
  });
}

/** The per-application commands as a node token reaches them, over the real app. */
function buildNodeOps(served: ReturnType<typeof createNodeApp>): ApplicationOps {
  return nodeOps({
    url: NODE_URL,
    authorize: () => signNodeToken(node.privateKey, NODE_ID),
    fetchFn: async (input, init) => {
      const url = urlOf(input);
      called.push(url);
      return served.request(url, init);
    },
  });
}

/** The admin surface as one operator key reaches it, over the real app. */
function reach(
  served: ReturnType<typeof createNodeApp>,
  id: string,
  keys: Keypair,
): ApplicationApi {
  return applicationApi({
    url: NODE_URL,
    authorize: () => signNodeToken(keys.privateKey, id),
    /* The app may answer synchronously; `fetch` never does. */
    fetchFn: async (input, init) => served.request(urlOf(input), init),
  });
}

async function trust(
  id: string,
  keys: Keypair,
  role: OperatorRole,
  applications?: string[],
): Promise<void> {
  await trustOperator(clock.ctx, {
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    role,
    ...(applications === undefined ? {} : { applications }),
  });
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
      bindHost: "127.0.0.1",
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
    list: (): ProcessStatus[] => [],
    forget: () => {},
    onExit: () => {},
  };
}
