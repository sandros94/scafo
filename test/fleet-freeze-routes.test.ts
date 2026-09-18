/* `/v1/fleet/freeze`: stopping and restarting this installation's deploy intake. */

import type { H3 } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { beforeEach, describe, expect, it } from "vitest";
import { signNodeToken } from "../src/core/auth/index.ts";
import type { ProblemDetails } from "../src/core/error.ts";
import { FREEZE_REASON_MAX, readFreeze } from "../src/core/registry/freeze.ts";
import { registerNode } from "../src/core/registry/nodes.ts";
import { type OperatorRole, trustOperator } from "../src/core/registry/operators.ts";
import type { FreezeRecord } from "../src/core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, TEST_VERSIONS } from "./_helpers.ts";

const PATH = "/v1/fleet/freeze";
const NODE_ID = "node-a";
const ADMIN_ID = "op-aaaa1111";
const TENANT_ID = "op-bbbb2222";
const REASON = "celld 0.5.0 upgrade";

type Keypair = { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };

let clock: ManualClock;
let admin: Keypair;
let tenant: Keypair;
let app: H3;

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

  app = createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    versions: TEST_VERSIONS,
  });
});

describe("POST /v1/fleet/freeze", () => {
  it("freezes for an admin, and records the CALLER as the one who decided", async () => {
    const response = await call("POST", await asKey(ADMIN_ID, admin), { reason: REASON });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { freeze: FreezeRecord; created: boolean };
    expect(body.created).toBe(true);
    expect(body.freeze).toEqual({
      v: 1,
      frozenAt: new Date(clock.nowMs()).toISOString(),
      by: ADMIN_ID,
      reason: REASON,
    });
    await expect(readFreeze(clock.ctx)).resolves.toEqual(body.freeze);
  });

  it("takes no body at all, because a freeze need not say why", async () => {
    const response = await call("POST", await asKey(ADMIN_ID, admin));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { freeze: FreezeRecord };
    expect(body.freeze.by).toBe(ADMIN_ID);
    expect(body.freeze).not.toHaveProperty("reason");
  });

  it("IGNORES a `by` the body states, whatever it says", async () => {
    /* The record is evidence of who stopped the fleet's deploys, so it is written
       from the verified token and never from the caller's text. */
    const response = await call("POST", await asKey(ADMIN_ID, admin), {
      by: TENANT_ID,
      reason: REASON,
    });

    const body = (await response.json()) as { freeze: FreezeRecord };
    expect(body.freeze.by).toBe(ADMIN_ID);
  });

  it("answers the first freeze, unchanged, when the fleet is already frozen", async () => {
    const first = (await (
      await call("POST", await asKey(ADMIN_ID, admin), { reason: REASON })
    ).json()) as {
      freeze: FreezeRecord;
    };
    clock.tick(60_000);

    const again = (await (
      await call("POST", await asKey(ADMIN_ID, admin), { reason: "a different reason" })
    ).json()) as { freeze: FreezeRecord; created: boolean };

    expect(again.created).toBe(false);
    expect(again.freeze).toEqual(first.freeze);
  });

  it("REFUSES an operator-tier key, and freezes nothing", async () => {
    const response = await call("POST", await asKey(TENANT_ID, tenant), { reason: REASON });

    expect(response.status).toBe(403);
    const problem = await problemOf(response);
    expect(problem.type).toBe("urn:scafo:auth-scope");
    expect(problem.detail).toContain("admin");
    await expect(readFreeze(clock.ctx)).resolves.toBeNull();
  });

  it("bounds the reason, since every refused deploy prints it", async () => {
    const response = await call("POST", await asKey(ADMIN_ID, admin), {
      reason: "x".repeat(FREEZE_REASON_MAX + 1),
    });

    expect(response.status).toBe(400);
    expect((await problemOf(response)).type).toBe("urn:scafo:invalid-input");
    await expect(readFreeze(clock.ctx)).resolves.toBeNull();
  });

  it("refuses a reason that is not a string", async () => {
    const response = await call("POST", await asKey(ADMIN_ID, admin), { reason: 7 });

    expect(response.status).toBe(400);
    expect((await problemOf(response)).type).toBe("urn:scafo:invalid-input");
  });
});

describe("DELETE /v1/fleet/freeze", () => {
  it("says whether there was a freeze to lift", async () => {
    await call("POST", await asKey(ADMIN_ID, admin), { reason: REASON });

    const lifted = await call("DELETE", await asKey(ADMIN_ID, admin));
    expect(lifted.status).toBe(200);
    await expect(lifted.json()).resolves.toEqual({ lifted: true });

    const again = await call("DELETE", await asKey(ADMIN_ID, admin));
    await expect(again.json()).resolves.toEqual({ lifted: false });
    await expect(readFreeze(clock.ctx)).resolves.toBeNull();
  });

  it("REFUSES an operator-tier key, and leaves the freeze standing", async () => {
    await call("POST", await asKey(ADMIN_ID, admin), { reason: REASON });

    const response = await call("DELETE", await asKey(TENANT_ID, tenant));

    expect(response.status).toBe(403);
    expect((await problemOf(response)).type).toBe("urn:scafo:auth-scope");
    await expect(readFreeze(clock.ctx)).resolves.not.toBeNull();
  });
});

describe("GET /v1/fleet/freeze", () => {
  it("answers the record to any operator of the fleet", async () => {
    await call("POST", await asKey(ADMIN_ID, admin), { reason: REASON });

    const response = await call("GET", await asKey(TENANT_ID, tenant));

    /* Whoever is refused a deploy is owed the reason, whatever tier their key is. */
    expect(response.status).toBe(200);
    const body = (await response.json()) as { freeze: FreezeRecord };
    expect(body.freeze).toMatchObject({ by: ADMIN_ID, reason: REASON });
  });

  it("answers not-found while the fleet takes deploys", async () => {
    const response = await call("GET", await asKey(ADMIN_ID, admin));

    expect(response.status).toBe(404);
    expect((await problemOf(response)).type).toBe("urn:scafo:not-found");
  });
});

/* ---------------------------------------------------------------- helpers */

async function call(
  method: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<Response> {
  return app.request(PATH, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function problemOf(response: Response): Promise<ProblemDetails> {
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  return (await response.json()) as ProblemDetails;
}

async function asKey(id: string, keys: Keypair): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await signNodeToken(keys.privateKey, id)}` };
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
