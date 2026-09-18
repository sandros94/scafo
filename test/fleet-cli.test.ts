/* `scafo fleet freeze` and `scafo fleet unfreeze` through the node API. */

import type { CommandContext, CommandDef } from "citty";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeFreeze, describeUnfreeze, type FleetApi, fleetApi } from "../src/cli/_fleet.ts";
import { fleet } from "../src/cli/commands/fleet.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import { readFreeze } from "../src/core/registry/freeze.ts";
import { registerNode } from "../src/core/registry/nodes.ts";
import { type OperatorRole, trustOperator } from "../src/core/registry/operators.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith, TEST_VERSIONS, urlOf } from "./_helpers.ts";

const NODE_ID = "node-a";
const NODE_URL = "http://10.0.0.4:7400";
const ADMIN_ID = "op-aaaa1111";
const TENANT_ID = "op-bbbb2222";
const REASON = "celld 0.5.0 upgrade";

type Keypair = { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };

const dirs: string[] = [];

let clock: ManualClock;
let admin: Keypair;
let tenant: Keypair;
/** The fleet surface as an ADMIN of the installation reaches it. */
let asAdmin: FleetApi;
/** The same, as an operator-tier key. */
let asTenant: FleetApi;

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
  await trust(TENANT_ID, tenant, "operator", ["acme"]);

  const app = createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    versions: TEST_VERSIONS,
  });
  asAdmin = reach(app, ADMIN_ID, admin);
  asTenant = reach(app, TENANT_ID, tenant);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  /* Every reported failure sets it, and a suite that left it set would report
     the whole run as failed. */
  process.exitCode = undefined;
});

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("scafo fleet freeze", () => {
  it("says since when, by whom, why, the code and the way back out", async () => {
    const line = describeFreeze(await asAdmin.freeze(REASON));

    const frozenAt = (await readFreeze(clock.ctx))?.frozenAt;
    expect(line).toBe(
      `scafo: deploys are frozen since ${String(frozenAt)} by "${ADMIN_ID}": ${REASON} — every ` +
        `deploy is refused with deploys-frozen until "scafo fleet unfreeze"`,
    );
  });

  it("leaves the reason clause out when there is no reason", async () => {
    const line = describeFreeze(await asAdmin.freeze());

    const frozenAt = (await readFreeze(clock.ctx))?.frozenAt;
    expect(line).toBe(
      `scafo: deploys are frozen since ${String(frozenAt)} by "${ADMIN_ID}" — every deploy is ` +
        `refused with deploys-frozen until "scafo fleet unfreeze"`,
    );
  });

  it("says a second freeze changed nothing, and whose decision is standing", async () => {
    await asAdmin.freeze(REASON);
    clock.tick(60_000);

    const line = describeFreeze(await asAdmin.freeze("a different reason"));

    expect(line).toContain(`deploys were already frozen since`);
    expect(line).toContain(REASON);
    expect(line).not.toContain("a different reason");
  });

  it("REFUSES an operator-tier key, whatever it says", async () => {
    const error = await rejectsWith(() => asTenant.freeze(REASON), "auth-scope");

    expect(error.detail).toContain("admin");
    await expect(readFreeze(clock.ctx)).resolves.toBeNull();
  });
});

describe("scafo fleet unfreeze", () => {
  it("says the fleet takes deploys again, and says so only when it lifted one", async () => {
    await asAdmin.freeze(REASON);

    expect(describeUnfreeze(await asAdmin.unfreeze())).toBe(
      "scafo: deploys are no longer frozen; nodes accept them again",
    );
    expect(describeUnfreeze(await asAdmin.unfreeze())).toBe("scafo: deploys were not frozen");
    await expect(readFreeze(clock.ctx)).resolves.toBeNull();
  });

  it("REFUSES an operator-tier key, and leaves the freeze standing", async () => {
    await asAdmin.freeze(REASON);

    await rejectsWith(() => asTenant.unfreeze(), "auth-scope");

    await expect(readFreeze(clock.ctx)).resolves.not.toBeNull();
  });
});

describe("with nothing naming a node", () => {
  it("refuses both commands rather than reaching for the bucket", async () => {
    for (const name of ["freeze", "unfreeze"]) {
      const said = await runWithoutNode(name);

      /* Freezing is an authorization a bucket cannot enforce, so there is no
         bucket path to fall back to: the refusal says what to pass instead. */
      expect(said, name).toHaveLength(1);
      expect(said[0], name).toContain("No node to ask");
      expect(said[0], name).toContain("--node");
      expect(said[0], name).toContain("[urn:scafo:invalid-input]");
      expect(process.exitCode, name).toBe(1);
      process.exitCode = undefined;
    }
  });
});

/* ---------------------------------------------------------------- helpers */

/** Runs one fleet subcommand against an operator home that holds no remote. */
async function runWithoutNode(name: string): Promise<string[]> {
  const home = await mkdtemp(join(tmpdir(), "scafo-fleet-cli-"));
  dirs.push(home);
  vi.stubEnv("SCAFO_HOME", home);
  vi.stubEnv("SCAFO_REMOTE", "");
  vi.stubEnv("SCAFO_OPERATOR_KEY", "");

  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  });

  const command = (fleet.subCommands as Record<string, CommandDef>)[name] as CommandDef;
  await command.run?.({
    rawArgs: [],
    cmd: command,
    /* A config path nothing is at, so no remote pin beside the terminal decides
       this run for it. */
    args: { _: [], config: join(home, "absent.jsonc") },
  } as unknown as CommandContext);
  return lines;
}

/** The fleet surface as one key reaches it, over the real app. */
function reach(app: ReturnType<typeof createNodeApp>, id: string, keys: Keypair): FleetApi {
  return fleetApi({
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
  applications?: string[],
): Promise<void> {
  await trustOperator(clock.ctx, {
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    role,
    ...(applications === undefined ? {} : { applications }),
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
    runtime: { binPath: "celld", portRangeStart: 42_000, bindHost: "127.0.0.1" },
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
