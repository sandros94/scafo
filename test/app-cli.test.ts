/*
 * `scafo app`: the whole group, over each way it reaches an installation.
 *
 * The admin verbs — list, show, block, unblock, label — go through a NODE on the
 * authority of an operator key. The rest also write straight into the bucket
 * when no node is named, so retire, unretire, selector, replicas, the domain
 * claims and delete are exercised over both.
 */

import { type ArgsDef, type CommandDef, parseArgs } from "citty";
import { generateJWK } from "unjwt/jwk";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  describeDomains,
  readLabelArgs,
  readSelectorFlags,
  type ApplicationView,
  WILDCARD_MARK,
} from "../src/cli/_applications.ts";
import { resolveApplication } from "../src/cli/_application.ts";
import {
  acmeChallengeHost,
  checkAcmeDelegation,
  checkDomainDns,
  describeDnsPending,
  describeDnsSettled,
  describeDomainClaim,
  describeWildcardCertificates,
  describeWildcardDnsPending,
  describeWildcardDnsSettled,
  describeWildcardIssuance,
  type HostResolver,
  wildcardProbeHost,
} from "../src/cli/_domains.ts";
import { warn } from "../src/cli/_warn.ts";
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
  heartbeatNode,
  registerNode,
  retireApplication,
} from "../src/core/registry/index.ts";
import { type OperatorRole, trustOperator } from "../src/core/registry/operators.ts";
import type { ApplicationRecord, CoordinatorLease } from "../src/core/types/registry.ts";
import { isHost } from "../src/core/utils/host.ts";
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

/** The platform domain the fixture's node serves, and two hosts outside it. */
const PLATFORM_DOMAIN = "apps.test";
const HOST = "shop.example.com";
const OTHER_HOST = "www.example.com";

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
/** The same node, signed for by the admin key an operator would hold. */
let operatorOps: ApplicationOps;

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
  operatorOps = buildNodeOps(served, { id: ADMIN_ID, keys: admin });
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

    const seen = await asAdmin.show(MINE);
    const shown = formatApplication(seen.application, seen.serving);

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
    const retired = formatApplication((await asAdmin.show(PREVIEW)).application);

    expect(retired).toContain("Retired at");
    expect(retired).toContain(`scafo app unretire --name`);

    const blocked = formatApplication(await asAdmin.block(MINE));

    expect(blocked).toContain("blocked");
    expect(blocked).toContain(`scafo app unblock --name ${MINE}`);
  });

  it("answers --json with the record and what the fleet says, rather than a rendering", async () => {
    const view = await asAdmin.show(MINE);

    expect(showJson(view)).toEqual(view);
    expect(view.application.name).toBe(MINE);
    /* The fleet's own word about it travels with the record: an application
       failing on one node is a fact a script must be able to read too. */
    expect(view.serving).toEqual({ nodes: 0, serving: 0, failing: [] });
    /* Declared, because the rendering above is only reachable through the flag. */
    expect(subCommand("show").args).toHaveProperty("json");
  });

  /*
   * The incident: two nodes serving the application, one restarting its process
   * every fifteen seconds, and every scafo surface calling it plainly "serving".
   */
  it("stops claiming plain serving while a live node reports the application failing", async () => {
    await heartbeatNode(clock.ctx, NODE_ID, {
      serving: {},
      failing: {
        [MINE]: {
          since: "2026-01-01T00:00:00.000Z",
          restarts: 6,
          lastError: "Error: node authority was not established before wake scan",
        },
      },
    });
    await registerNode(clock.ctx, {
      v: 1,
      id: "node-b",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "x-node-b" },
      addresses: { internal: "10.0.0.5", apiPort: 7400 },
    });
    await heartbeatNode(clock.ctx, "node-b", { serving: { [MINE]: { port: 24_000 } } });

    const view = await asAdmin.show(MINE);

    expect(view.serving).toEqual({
      nodes: 2,
      serving: 1,
      failing: [
        {
          node: NODE_ID,
          since: "2026-01-01T00:00:00.000Z",
          restarts: 6,
          lastError: "Error: node authority was not established before wake scan",
        },
      ],
    });

    const shown = formatApplication(view.application, view.serving);
    expect(shown).toContain("state       serving on 1 of 2 nodes");
    expect(shown).toContain("Failing on 1 of 2 nodes");
    expect(shown).toContain(`${NODE_ID}  6 restarts since 2026-01-01T00:00:00.000Z`);
    expect(shown).toContain("node authority was not established before wake scan");
    /* Scafo reports and never repairs: the line says whose words those are. */
    expect(shown).toContain("never repairs the runtime's own state");
  });

  it("shows a scoped key its own application without the fleet's labels", async () => {
    await asAdmin.setLabels(MINE, { account: "acct-4417" });

    const seen = (await asTenant.show(MINE)).application;

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

describe.each([
  ["through a node daemon", (): ApplicationOps => throughNodeAsOperator()],
  ["straight through the bucket", (): ApplicationOps => throughBucket()],
])("claiming a custom domain %s", (_name, build) => {
  it("claims the host, mirrors it, and names where it already answers", async () => {
    const change = await build().addDomain(MINE, HOST);

    expect(change.host).toBe(HOST);
    expect(change.application.domains).toEqual([HOST]);
    expect(change.platformHosts).toEqual([`${MINE}.${PLATFORM_DOMAIN}`]);
    expect((await getApplication(clock.ctx, MINE)).domains).toEqual([HOST]);
  });

  it("takes the host as DNS reads it, and claiming it twice changes nothing", async () => {
    await build().addDomain(MINE, "Shop.Example.COM");
    const again = await build().addDomain(MINE, HOST);

    expect(again.application.domains).toEqual([HOST]);
  });

  it("releases it again, and leaves the application every other host it has", async () => {
    await build().addDomain(MINE, HOST);
    await build().addDomain(MINE, OTHER_HOST);

    const change = await build().removeDomain(MINE, HOST);

    expect(change.application.domains).toEqual([OTHER_HOST]);
    expect((await build().show(MINE)).domains).toEqual([OTHER_HOST]);
  });

  it("refuses to release a host another application holds", async () => {
    await build().addDomain(THEIRS, HOST);

    expect((await rejectionOf(() => build().removeDomain(MINE, HOST))).code).toBe("not-found");
    expect((await getApplication(clock.ctx, THEIRS)).domains).toEqual([HOST]);
  });

  it("refuses a host of the installation's own domains, which name applications", async () => {
    const error = await rejectsWith(
      () => build().addDomain(MINE, `${MINE}.${PLATFORM_DOMAIN}`),
      "invalid-input",
    );

    expect(error.detail).toContain(PLATFORM_DOMAIN);
    expect((await getApplication(clock.ctx, MINE)).domains).toEqual([]);
  });

  it("refuses a host that is not one before anything is written", async () => {
    await rejectsWith(() => build().addDomain(MINE, "https://shop.example.com"), "invalid-input");

    expect((await getApplication(clock.ctx, MINE)).domains).toEqual([]);
  });

  it("gives a host claimed elsewhere to the one that claimed it first", async () => {
    await build().addDomain(THEIRS, HOST);

    const error = await rejectsWith(() => build().addDomain(MINE, HOST), "reference-held");

    expect(error.status).toBe(409);
    expect((await getApplication(clock.ctx, MINE)).domains).toEqual([]);
  });

  it("reports an application that is not there rather than inventing one", async () => {
    expect((await rejectionOf(() => build().addDomain("ghost", HOST))).code).toBe("not-found");
  });

  it("claims it with the one label below it when asked, and mirrors that too", async () => {
    const change = await build().addDomain(MINE, HOST, { wildcard: true });

    expect(change.application.domains).toEqual([HOST]);
    expect(change.application.wildcardDomains).toEqual([HOST]);
  });

  it("upgrades a plain claim and never quietly undoes one", async () => {
    await build().addDomain(MINE, HOST);
    expect((await build().show(MINE)).wildcardDomains).toBeUndefined();

    await build().addDomain(MINE, HOST, { wildcard: true });
    /* The flag is absent here exactly as it is when nobody passes `--wildcard`. */
    const again = await build().addDomain(MINE, HOST, {});

    expect(again.application.wildcardDomains).toEqual([HOST]);
  });

  it("releases the whole claim, subdomains and all", async () => {
    await build().addDomain(MINE, HOST, { wildcard: true });

    const change = await build().removeDomain(MINE, HOST);

    expect(change.application.domains).toEqual([]);
    expect(change.application.wildcardDomains).toBeUndefined();
  });
});

describe("what the domain commands are declared as", () => {
  it("takes the host as a positional and addresses <name>-<env> like every sibling", () => {
    const flags = parseArgs(
      [HOST, "--name", MINE, "--env", "preview"],
      domainCommand("add").args as never,
    ) as Record<string, unknown>;

    expect(flags.host).toBe(HOST);
    expect(resolveApplication({ name: flags.name as string, env: flags.env as string })).toBe(
      PREVIEW,
    );
  });

  it("offers --json on all three, and the bucket flags the other setters take", () => {
    for (const name of ["add", "remove", "list"]) {
      const args = domainCommand(name).args;
      expect(args, name).toHaveProperty("json");
      expect(args, name).toHaveProperty("node");
      expect(args, name).toHaveProperty("endpoint");
    }
  });

  it("offers --wildcard on `add` alone, and reads it as a boolean", () => {
    /* Not on `remove`, which drops the claim whole either way, and not on
       `list`, which reports what the record says. */
    expect(domainCommand("add").args).toHaveProperty("wildcard");
    expect(domainCommand("remove").args).not.toHaveProperty("wildcard");
    expect(domainCommand("list").args).not.toHaveProperty("wildcard");

    const flags = parseArgs(
      [HOST, "--name", MINE, "--wildcard"],
      domainCommand("add").args as never,
    ) as Record<string, unknown>;
    expect(flags.wildcard).toBe(true);
    /* Nobody types a `*`: the flag is the whole of how one is asked for. */
    expect(flags.host).toBe(HOST);
  });

  it("carries the whole change in the JSON a claim answers with", async () => {
    const change = await throughBucket().addDomain(MINE, HOST);
    const dns = await checkDomainDns({
      host: change.host,
      platformHosts: change.platformHosts,
      resolve: fixedResolver({ [HOST]: ["203.0.113.9"] }),
    });

    /* What `--json` prints: the record, the host, where it points, and what DNS
       says right now — never prose an operator would have to parse. */
    expect(JSON.parse(JSON.stringify({ ...change, dns }))).toEqual({
      application: await getApplication(clock.ctx, MINE),
      host: HOST,
      platformHosts: [`${MINE}.${PLATFORM_DOMAIN}`],
      dns: "unknown",
    });
  });

  it("asks a second question for a wildcard, and prints the answer beside the first", async () => {
    const change = await throughBucket().addDomain(MINE, HOST, { wildcard: true });
    const platformHosts = change.platformHosts;
    /* A label nothing is ever deployed at: what resolves there is the `*` record
       and nothing else. */
    const resolve = fixedResolver({
      [HOST]: ["203.0.113.9"],
      [wildcardProbeHost(HOST)]: ["203.0.113.9"],
      [platformHosts[0] as string]: ["203.0.113.9"],
    });

    const dns = await checkDomainDns({ host: change.host, platformHosts, resolve });
    const wildcardDns = await checkDomainDns({
      host: wildcardProbeHost(change.host),
      platformHosts,
      resolve,
    });

    expect(wildcardProbeHost(HOST)).toBe(`scafo-dns-check.${HOST}`);
    expect(JSON.parse(JSON.stringify({ ...change, dns, wildcardDns }))).toEqual({
      application: await getApplication(clock.ctx, MINE),
      host: HOST,
      platformHosts,
      dns: "ok",
      wildcardDns: "ok",
    });

    /* The record is missing where nothing answers for the probe label, and the
       host's own answer is untouched by it. */
    const without = fixedResolver({
      [HOST]: ["203.0.113.9"],
      [platformHosts[0] as string]: ["203.0.113.9"],
    });
    await expect(
      checkDomainDns({ host: wildcardProbeHost(HOST), platformHosts, resolve: without }),
    ).resolves.toBe("unknown");
    await expect(checkDomainDns({ host: HOST, platformHosts, resolve: without })).resolves.toBe(
      "ok",
    );
  });

  it("says what a wildcard claim still needs of DNS and of the ingress", () => {
    const platformHosts = [`${MINE}.${PLATFORM_DOMAIN}`];
    const pending = describeWildcardDnsPending(HOST, platformHosts);

    expect(pending).toContain(`"*.${HOST}"`);
    expect(pending).toContain(`CNAME to "${platformHosts[0] as string}"`);
    expect(describeWildcardDnsPending(HOST, [])).not.toContain("CNAME");
    expect(describeWildcardDnsSettled(HOST)).toContain(`"*.${HOST}"`);

    /* And the half DNS cannot fix: an arbitrary subdomain gets no certificate
       of its own, so the ingress has to hold one that covers them. */
    const certificates = describeWildcardCertificates(HOST);
    expect(certificates).toContain(`"*.${HOST}"`);
    expect(certificates).toContain("DNS-01");
  });

  it("marks a wildcard claim wherever a host is printed, and never as a `*`", async () => {
    await throughBucket().addDomain(MINE, HOST, { wildcard: true });
    await throughBucket().addDomain(MINE, OTHER_HOST);
    const application = await getApplication(clock.ctx, MINE);

    expect(describeDomains(application)).toEqual([`${HOST} ${WILDCARD_MARK}`, OTHER_HOST]);
    const shown = formatApplication(application);
    expect(shown).toContain(`${HOST} ${WILDCARD_MARK}`);
    expect(shown).not.toContain(`*.${HOST}`);
  });

  it("says in one line what a claim did, and whether it covers the names under it", async () => {
    const plain = await throughBucket().addDomain(MINE, OTHER_HOST);
    expect(describeDomainClaim(plain, "the registry bucket")).not.toContain("one label under");

    const covering = await throughBucket().addDomain(MINE, HOST, { wildcard: true });
    const line = describeDomainClaim(covering, "the registry bucket");
    expect(line).toContain(`"<env>.${HOST}"`);
    expect(line).toContain(`"${MINE}-<env>"`);
  });
});

describe("what DNS says about a host that was just claimed", () => {
  const platformHosts = [`${MINE}.${PLATFORM_DOMAIN}`];

  it("is ok when the claimed host already resolves where the application answers", async () => {
    const outcome = await checkDomainDns({
      host: HOST,
      platformHosts,
      resolve: fixedResolver({
        [HOST]: ["2001:db8::5", "203.0.113.9"],
        [platformHosts[0] as string]: ["203.0.113.9"],
      }),
    });

    expect(outcome).toBe("ok");
    expect(describeDnsSettled(HOST)).toContain(HOST);
  });

  it("is pending when it resolves somewhere else entirely", async () => {
    const outcome = await checkDomainDns({
      host: HOST,
      platformHosts,
      resolve: fixedResolver({
        [HOST]: ["198.51.100.2"],
        [platformHosts[0] as string]: ["203.0.113.9"],
      }),
    });

    expect(outcome).toBe("pending");
  });

  it("is unknown when the resolver says nothing, and never fails the claim", async () => {
    const nxdomain = await checkDomainDns({
      host: HOST,
      platformHosts,
      resolve: () => Promise.reject(new Error("queryA ENOTFOUND")),
    });
    const silent = await checkDomainDns({
      host: HOST,
      platformHosts,
      resolve: (host) => (host === HOST ? Promise.resolve(["203.0.113.9"]) : Promise.resolve([])),
    });
    const late = await checkDomainDns({
      host: HOST,
      platformHosts,
      budgetMs: 5,
      resolve: () => new Promise<string[]>(() => {}),
    });

    expect([nxdomain, silent, late]).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("says what is still to do, through the channel one switch silences", () => {
    const pending = describeDnsPending(HOST, platformHosts);
    expect(pending).toContain(HOST);
    expect(pending).toContain(`CNAME to "${platformHosts[0] as string}"`);
    expect(pending).toContain("certificate");

    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    warn(pending);
    vi.stubEnv("SCAFO_SILENCE_WARNINGS", "1");
    warn(pending);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();

    expect(lines).toEqual([`scafo: warning: ${pending}`]);
  });

  it("says nothing about a CNAME when the installation serves no platform domain", () => {
    expect(describeDnsPending(HOST, [])).not.toContain("CNAME");
  });
});

describe("whether the challenge for a covered base is delegated to the ingress", () => {
  const DELEGATION = "acme.scafo.test";
  const CHALLENGE = `_acme-challenge.${HOST}`;

  it("asks under the label a certificate authority reads, which is no host of ours", () => {
    /* Its first label starts with an underscore, so it is not a name anything
       here could be claimed, routed or served at — and never has to be. */
    expect(acmeChallengeHost(HOST)).toBe(CHALLENGE);
    expect(isHost(CHALLENGE)).toBe(false);
  });

  it("is ok when the record already names where this installation answers", async () => {
    const outcome = await checkAcmeDelegation({
      host: HOST,
      delegation: DELEGATION,
      resolveCname: fixedResolver({ [CHALLENGE]: [DELEGATION] }),
    });

    expect(outcome).toBe("ok");
  });

  it("reads one name through two spellings of it: case, and the root's dot", async () => {
    const outcome = await checkAcmeDelegation({
      host: HOST,
      delegation: DELEGATION,
      resolveCname: fixedResolver({ [CHALLENGE]: [`${DELEGATION.toUpperCase()}.`] }),
    });

    expect(outcome).toBe("ok");
  });

  it("is pending when the record points at something else entirely", async () => {
    const outcome = await checkAcmeDelegation({
      host: HOST,
      delegation: DELEGATION,
      resolveCname: fixedResolver({ [CHALLENGE]: ["acme.somebody-else.test"] }),
    });

    expect(outcome).toBe("pending");
  });

  it("is unknown when the resolver says nothing, and never fails the claim", async () => {
    const nxdomain = await checkAcmeDelegation({
      host: HOST,
      delegation: DELEGATION,
      resolveCname: fixedResolver({}),
    });
    const silent = await checkAcmeDelegation({
      host: HOST,
      delegation: DELEGATION,
      resolveCname: () => Promise.resolve([]),
    });
    const late = await checkAcmeDelegation({
      host: HOST,
      delegation: DELEGATION,
      budgetMs: 5,
      resolveCname: () => new Promise<string[]>(() => {}),
    });

    expect([nxdomain, silent, late]).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("REPLACES the standing warning with the record to create, once there is one", () => {
    const standing = describeWildcardIssuance(HOST, undefined, undefined);
    const pending = describeWildcardIssuance(HOST, DELEGATION, "pending");
    const unknown = describeWildcardIssuance(HOST, DELEGATION, "unknown");

    /* Without a delegation, the sentence an operator read before this existed. */
    expect(standing).toEqual({ text: describeWildcardCertificates(HOST), settled: false });

    /* With one, the exact record instead of the advice to arrange DNS-01 somehow. */
    for (const notice of [pending, unknown]) {
      expect(notice.settled).toBe(false);
      expect(notice.text).toContain(`"${CHALLENGE} CNAME ${DELEGATION}"`);
      expect(notice.text).toContain(`"*.${HOST}"`);
      expect(notice.text).not.toBe(standing.text);
    }
  });

  it("acknowledges a delegation already in place rather than warning about it", () => {
    const settled = describeWildcardIssuance(HOST, DELEGATION, "ok");

    expect(settled.settled).toBe(true);
    expect(settled.text).toContain(CHALLENGE);
    expect(settled.text).toContain(DELEGATION);
  });

  it("goes out through the channel one switch silences, and never as a failure", () => {
    const notice = describeWildcardIssuance(HOST, DELEGATION, "pending");
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    warn(notice.text);
    vi.stubEnv("SCAFO_SILENCE_WARNINGS", "1");
    warn(notice.text);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();

    expect(lines).toEqual([`scafo: warning: ${notice.text}`]);
  });

  it("carries the third answer in the JSON a covered claim prints", async () => {
    const ops = directOps(clock.ctx, {
      platformDomains: [PLATFORM_DOMAIN],
      acmeDelegation: DELEGATION,
    });
    const change = await ops.addDomain(MINE, HOST, { wildcard: true });
    const acmeDns = await checkAcmeDelegation({
      host: change.host,
      delegation: DELEGATION,
      resolveCname: fixedResolver({ [CHALLENGE]: [DELEGATION] }),
    });

    /* The bucket-direct path reads the delegation from the same configuration a
       node would have answered with, so `--json` says the same thing either way. */
    expect(JSON.parse(JSON.stringify({ ...change, dns: "unknown", acmeDns }))).toEqual({
      application: await getApplication(clock.ctx, MINE),
      host: HOST,
      platformHosts: [`${MINE}.${PLATFORM_DOMAIN}`],
      acmeDelegation: DELEGATION,
      dns: "unknown",
      acmeDns: "ok",
    });
  });

  it("says nothing of a delegation where the installation names none", async () => {
    const change = await throughBucket().addDomain(MINE, HOST, { wildcard: true });

    expect(change).not.toHaveProperty("acmeDelegation");
    expect(describeWildcardIssuance(change.host, change.acmeDelegation, undefined).text).toBe(
      describeWildcardCertificates(HOST),
    );
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
  return directOps(clock.ctx, { platformDomains: [PLATFORM_DOMAIN] });
}

/**
 * The same node, reached with an OPERATOR key rather than a node token: what an
 * operator's own `scafo app` really signs with, and what the routes an operator
 * alone may call answer to.
 */
function throughNodeAsOperator(): ApplicationOps {
  return operatorOps;
}

/** A resolver that answers from a table, and NXDOMAINs anything not in it. */
function fixedResolver(table: Record<string, string[]>): HostResolver {
  return (host) => {
    const found = table[host];
    return found === undefined
      ? Promise.reject(new Error(`queryA ENOTFOUND ${host}`))
      : Promise.resolve(found);
  };
}

/** One of the three commands under `scafo app domain`. */
function domainCommand(name: string): CommandDef & { args: ArgsDef } {
  const group = subCommand("domain");
  return (group.subCommands as Record<string, CommandDef>)[name] as CommandDef & { args: ArgsDef };
}

/** What `scafo app show --json` prints, read back. */
function showJson(view: ApplicationView): unknown {
  return JSON.parse(JSON.stringify(view, null, 2));
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
function buildNodeOps(
  served: ReturnType<typeof createNodeApp>,
  as?: { id: string; keys: Keypair },
): ApplicationOps {
  return nodeOps({
    url: NODE_URL,
    authorize: () => signNodeToken(as?.keys.privateKey ?? node.privateKey, as?.id ?? NODE_ID),
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
      skippedAssignments: 0,
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
    platformDomains: [PLATFORM_DOMAIN],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      portRangeEnd: 42_998,
      portQuarantineMs: 600_000,
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
