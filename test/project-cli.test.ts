/* `scafo project` commands through the node API. */

import { type CommandDef, parseArgs } from "citty";
import { generateJWK } from "unjwt/jwk";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { beforeEach, describe, expect, it } from "vitest";
import { project, trailingPositionals } from "../src/cli/commands/project.ts";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import {
  formatProject,
  formatProjectTable,
  type ProjectApi,
  projectApi,
  readLabelArgs,
} from "../src/cli/_projects.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import { createProject, getProject, registerNode } from "../src/core/registry/index.ts";
import { type OperatorRole, trustOperator } from "../src/core/registry/operators.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
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
const MINE = "acme";
const THEIRS = "zenith";

type Keypair = { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };

let clock: ManualClock;
let admin: Keypair;
let tenant: Keypair;
/** The API as an ADMIN of the fleet reaches it. */
let asAdmin: ProjectApi;
/** The same, as an operator-tier key scoped to {@link MINE}. */
let asTenant: ProjectApi;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  admin = await generateJWK("EdDSA", { kid: ADMIN_ID });
  tenant = await generateJWK("EdDSA", { kid: TENANT_ID });

  await registerNode(clock.ctx, {
    v: 1,
    id: NODE_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: "x-for-node-a" },
    addresses: { internal: "10.0.0.4", apiPort: 7400 },
  });
  await trust(ADMIN_ID, admin, "admin");
  await trust(TENANT_ID, tenant, "operator", [MINE]);
  for (const slug of [MINE, THEIRS]) await createProject(clock.ctx, { slug });

  const app = buildApp();
  asAdmin = reach(app, ADMIN_ID, admin);
  asTenant = reach(app, TENANT_ID, tenant);
});

describe("scafo project list", () => {
  it("shows an admin every project, with the blocked ones marked", async () => {
    await asAdmin.block(THEIRS);

    const listing = await asAdmin.list();

    expect(listing.projects.map((entry) => entry.slug)).toEqual([MINE, THEIRS]);
    expect(listing.scoped).toBeUndefined();
    const table = formatProjectTable(listing);
    expect(table).toContain("2 projects, 1 blocked");
    expect(table).toMatch(new RegExp(`${THEIRS}\\s+blocked`));
    expect(table).toMatch(new RegExp(`${MINE}\\s+serving`));
  });

  it("shows a scoped key only what it reaches, and SAYS the answer is narrowed", async () => {
    const listing = await asTenant.list();

    expect(listing.projects.map((entry) => entry.slug)).toEqual([MINE]);
    expect(listing.scoped).toBe(true);

    /*
     * The header has to say it. A filtered listing and a whole one are the same
     * shape, so a tenant reading an unmarked one would conclude the fleet has
     * exactly one project — and, worse, that it has seen all of it.
     */
    const table = formatProjectTable(listing);
    expect(table).toContain("the projects this key reaches");
    expect(table).not.toContain(THEIRS);
  });

  it("says so plainly when there is nothing to show", async () => {
    expect(formatProjectTable({ projects: [] })).toContain("no project here");
    expect(formatProjectTable({ projects: [], scoped: true })).toContain(
      "no project here that this key reaches",
    );
  });
});

describe("scafo project block", () => {
  it("blocks for an admin and takes it back, both idempotently", async () => {
    await expect(asAdmin.block(MINE)).resolves.toMatchObject({ blocked: true });
    await expect(asAdmin.block(MINE)).resolves.toMatchObject({ blocked: true });
    await expect(getProject(clock.ctx, MINE)).resolves.toMatchObject({ blocked: true });

    await expect(asAdmin.unblock(MINE)).resolves.not.toHaveProperty("blocked");
    await expect(asAdmin.unblock(MINE)).resolves.not.toHaveProperty("blocked");
    await expect(getProject(clock.ctx, MINE)).resolves.not.toHaveProperty("blocked");
  });

  it("REFUSES an operator-tier key on its own project", async () => {
    const error = await rejectsWith(() => asTenant.block(MINE), "auth-scope");

    expect(error.detail).toContain("admin");
    await expect(getProject(clock.ctx, MINE)).resolves.not.toHaveProperty("blocked");
  });

  it("refuses it on somebody else's with the ordinary out-of-scope answer", async () => {
    /* Not the tier refusal: a key that does not reach the project must not learn
       that blocking is a thing that could be done to it. */
    await rejectsWith(() => asTenant.block(THEIRS), "auth-scope");
    await expect(getProject(clock.ctx, THEIRS)).resolves.not.toHaveProperty("blocked");
  });

  it("refuses a slug that could never name a project, before any call is made", async () => {
    expect((await rejectionOf(() => asAdmin.block("Not A Slug"))).code).toBe("invalid-slug");
  });

  it("answers not-found for a project this fleet does not hold", async () => {
    expect((await rejectionOf(() => asAdmin.block("nothing-here"))).code).toBe("not-found");
  });
});

describe("scafo project label", () => {
  it("replaces the whole map, and clears it when no pair is given", async () => {
    await asAdmin.setLabels(MINE, readLabelArgs(["tenant=acme", "plan=pro"]));
    await expect(getProject(clock.ctx, MINE)).resolves.toMatchObject({
      labels: { tenant: "acme", plan: "pro" },
    });

    await asAdmin.setLabels(MINE, readLabelArgs(["tenant=acme"]));
    await expect(getProject(clock.ctx, MINE)).resolves.toMatchObject({
      labels: { tenant: "acme" },
    });

    await asAdmin.setLabels(MINE, readLabelArgs([]));
    await expect(getProject(clock.ctx, MINE)).resolves.not.toHaveProperty("labels");
  });

  it("reads the pairs after the slug, which citty leaves among the positionals too", async () => {
    const subCommands = (await project.subCommands) as Record<string, CommandDef>;
    const argv = ["my-app", "tenant=acme", "plan=pro"];
    const flags = parseArgs(argv, subCommands.label?.args as never) as Record<string, unknown>;

    expect(flags.slug).toBe("my-app");
    expect(trailingPositionals(flags, 1)).toEqual(["tenant=acme", "plan=pro"]);
    expect(trailingPositionals(parseArgs(["my-app"], subCommands.label?.args as never), 1)).toEqual(
      [],
    );
  });

  it("keeps a value that carries its own separators", async () => {
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
    await expect(getProject(clock.ctx, MINE)).resolves.not.toHaveProperty("labels");
  });

  it("does not show them to an operator-tier key either, on its own project", async () => {
    await asAdmin.setLabels(MINE, { account: "acct-4417" });

    const listing = await asTenant.list();

    /* The read side matches the write side: labels are the fleet's notes about
       a tenant, so they neither leave through the API nor reach the terminal. */
    expect(listing.projects[0]).not.toHaveProperty("labels");
    expect(formatProjectTable(listing)).not.toContain("acct-4417");

    /* And the admin who wrote them still reads them back. */
    const mine = (await asAdmin.list()).projects.find((entry) => entry.slug === MINE);
    expect(formatProjectTable({ projects: [mine as never] })).toContain("account=acct-4417");
  });
});

describe("how one project prints", () => {
  it("names the state, the stamp and the way back out of a block", async () => {
    await asAdmin.setLabels(MINE, { tenant: "acme" });
    const blocked = await asAdmin.block(MINE);

    const shown = formatProject(blocked);

    expect(shown).toContain(`project "${MINE}"`);
    expect(shown).toContain("blocked by an admin of this fleet");
    expect(shown).toContain("tenant=acme");
    /* The way back is printed with the bad news, because somebody reading this
       is usually about to ask how to undo it. */
    expect(shown).toContain(`scafo project unblock ${MINE}`);
  });

  it("admits it does not know when a record predates the stamp", () => {
    const shown = formatProject({ v: 1, slug: MINE });

    expect(shown).toContain("unknown");
    expect(shown).toContain("serving");
  });
});

function buildApp(): ReturnType<typeof createNodeApp> {
  return createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    versions: TEST_VERSIONS,
  });
}

/** The project surface as one key reaches it, over the real app. */
function reach(app: ReturnType<typeof createNodeApp>, id: string, keys: Keypair): ProjectApi {
  return projectApi({
    url: NODE_URL,
    authorize: () => signNodeToken(keys.privateKey, id),
    /* The app may answer synchronously; `fetch` never does. */
    fetchFn: async (input, init) => app.request(urlOf(input), init),
  });
}

async function trust(
  id: string,
  keys: Keypair,
  role: OperatorRole,
  projects?: string[],
): Promise<void> {
  await trustOperator(clock.ctx, {
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    role,
    ...(projects === undefined ? {} : { projects }),
  });
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
