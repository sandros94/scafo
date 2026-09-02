/* Operator keys have their own keyspace but share the node identity namespace. */

import { generateJWK, type JWK_OKP_Public } from "unjwt/jwk";
import { beforeEach, describe, expect, it } from "vitest";
import { signNodeToken } from "../src/core/auth/index.ts";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { readJson } from "../src/core/registry/cas.ts";
import { getNode, listNodes, registerNode } from "../src/core/registry/nodes.ts";
import {
  getOperator,
  listOperators,
  revokeOperator,
  type TrustedOperator,
  trustOperator,
} from "../src/core/registry/operators.ts";
import { nodeKey, nodesPrefix, operatorKey, operatorsPrefix } from "../src/core/registry/paths.ts";
import { listFleetNodes } from "../src/cli/_nodes.ts";
import type { OperatorRecord } from "../src/core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const NODE_ID = "node-a";
/** Where the machine answers. Nothing an operator-facing refusal may ever say. */
const NODE_ADDRESS = "10.42.7.19";
const OPERATOR_ID = "op-aaaa1111";
const SECOND_ID = "op-bbbb2222";
const PROJECT = "acme";
const VERSION = "0.0.0-test";

let clock: ManualClock;

beforeEach(() => {
  clock = ctxWith(new MemoryCasStore());
});

describe("where the two kinds of record live", () => {
  it("files an operator key under operators/ and writes no node record at all", async () => {
    const keys = await generateJWK("EdDSA", { kid: OPERATOR_ID });
    await trustOperator(clock.ctx, {
      id: OPERATOR_ID,
      publicKey: publicHalf(keys.publicKey),
      role: "admin",
    });

    const stored = await readJson<OperatorRecord>(clock.ctx, operatorKey(OPERATOR_ID));
    expect(stored?.value).toMatchObject({ v: 1, id: OPERATOR_ID, role: "admin" });

    expect(await readJson(clock.ctx, nodeKey(OPERATOR_ID))).toBeNull();
    expect(await clock.ctx.store.list(nodesPrefix())).toEqual([]);
  });

  it("carries no addresses, because nothing ever connects to an operator", async () => {
    await trustAdmin(OPERATOR_ID);

    const stored = await readJson<Record<string, unknown>>(clock.ctx, operatorKey(OPERATOR_ID));

    expect(stored?.value.addresses).toBeUndefined();
  });

  it("lists operators out of their own prefix, never out of the machines'", async () => {
    await trustAdmin(OPERATOR_ID);
    await trustAdmin(SECOND_ID);
    await registerMachine();

    const trusted = await listOperators(clock.ctx);

    expect(trusted.map((entry) => entry.id)).toEqual([OPERATOR_ID, SECOND_ID]);
    expect(await clock.ctx.store.list(operatorsPrefix())).toHaveLength(2);
  });

  it("answers null for a machine's id, and for an operator's the key itself", async () => {
    await registerMachine();
    await trustAdmin(OPERATOR_ID);

    expect(await getOperator(clock.ctx, NODE_ID)).toBeNull();
    expect(await getOperator(clock.ctx, OPERATOR_ID)).toMatchObject({ id: OPERATOR_ID });
  });
});

describe("the machines listing", () => {
  it("shows machines alone, so a trusted key is not a node that never answers", async () => {
    await registerMachine();
    await trustAdmin(OPERATOR_ID);

    const listing = await listFleetNodes(clock.ctx, { now: new Date(clock.nowMs()) });

    expect(listing.map((entry) => entry.id)).toEqual([NODE_ID]);
    expect(await listNodes(clock.ctx)).toEqual([NODE_ID]);
  });
});

describe("one id is one identity, from both sides", () => {
  it("refuses an operator key filed under a machine's id", async () => {
    await registerMachine();

    const error = await rejectsWith(
      () => trustOperator(clock.ctx, { id: NODE_ID, publicKey: publicHalf(), role: "admin" }),
      "reference-held",
    );

    expect(error.detail).toContain(NODE_ID);
    expect(error.detail).not.toContain(NODE_ADDRESS);
    expect(JSON.stringify(error.toProblem())).not.toContain(NODE_ADDRESS);
  });

  it("refuses a machine registered under an operator key's id", async () => {
    await trustAdmin(OPERATOR_ID);

    const error = await rejectsWith(
      () =>
        registerNode(clock.ctx, {
          v: 1,
          id: OPERATOR_ID,
          publicKey: publicHalf(),
          addresses: { internal: NODE_ADDRESS, apiPort: 7400 },
        }),
      "reference-held",
    );

    expect(error.detail).toContain(OPERATOR_ID);
    expect(await getOperator(clock.ctx, OPERATOR_ID)).not.toBeNull();
  });

  it("lets a machine re-register itself, which is what every boot does", async () => {
    await registerMachine();
    await expect(registerMachine()).resolves.toMatchObject({ id: NODE_ID });
    await expect(getNode(clock.ctx, NODE_ID)).resolves.toMatchObject({ id: NODE_ID });
  });

  it("answers not-found for a revocation naming a machine, saying nothing about it", async () => {
    await registerMachine();
    await trustAdmin(OPERATOR_ID);

    const error = await rejectsWith(() => revokeOperator(clock.ctx, NODE_ID), "not-found");

    expect(error.detail).not.toContain(NODE_ADDRESS);
    await expect(getNode(clock.ctx, NODE_ID)).resolves.toMatchObject({ id: NODE_ID });
  });
});

describe("what the token verifier resolves a key out of", () => {
  it("authenticates an OPERATOR's token on a merely-authenticated route", async () => {
    const keys = await generateJWK("EdDSA", { kid: OPERATOR_ID });
    await registerMachine();
    await trustOperator(clock.ctx, {
      id: OPERATOR_ID,
      publicKey: publicHalf(keys.publicKey),
      role: "admin",
    });
    const app = nodeApp();

    const response = await app.request("/v1/state", {
      headers: { authorization: `Bearer ${await signNodeToken(keys.privateKey, OPERATOR_ID)}` },
    });

    expect(response.status).toBe(200);
  });

  it("authenticates a MACHINE's token on the same route", async () => {
    const keys = await generateJWK("EdDSA", { kid: NODE_ID });
    await registerNode(clock.ctx, {
      v: 1,
      id: NODE_ID,
      publicKey: publicHalf(keys.publicKey),
      addresses: { internal: NODE_ADDRESS, apiPort: 7400 },
    });
    const app = nodeApp();

    const response = await app.request("/v1/state", {
      headers: { authorization: `Bearer ${await signNodeToken(keys.privateKey, NODE_ID)}` },
    });

    expect(response.status).toBe(200);
  });

  it("refuses a MACHINE's token on the key-administration surface", async () => {
    const keys = await generateJWK("EdDSA", { kid: NODE_ID });
    await registerNode(clock.ctx, {
      v: 1,
      id: NODE_ID,
      publicKey: publicHalf(keys.publicKey),
      addresses: { internal: NODE_ADDRESS, apiPort: 7400 },
    });
    await trustAdmin(OPERATOR_ID);
    const app = nodeApp();

    const response = await app.request("/v1/operators", {
      headers: { authorization: `Bearer ${await signNodeToken(keys.privateKey, NODE_ID)}` },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
  });
});

describe("the record a fleet trusts", () => {
  it("round-trips the tier, the lineage and the scope", async () => {
    const wanted: TrustedOperator = {
      id: SECOND_ID,
      publicKey: publicHalf(),
      role: "operator",
      supersedes: OPERATOR_ID,
      projects: [PROJECT],
    };
    await trustOperator(clock.ctx, wanted);

    await expect(getOperator(clock.ctx, SECOND_ID)).resolves.toEqual(wanted);
  });

  it("reads a record carrying no role as the compat tier", async () => {
    await clock.ctx.store.put(
      operatorKey(OPERATOR_ID),
      JSON.stringify({ v: 1, id: OPERATOR_ID, publicKey: publicHalf() }),
    );

    await expect(getOperator(clock.ctx, OPERATOR_ID)).resolves.toMatchObject({ role: "admin" });
  });
});

function publicHalf(key?: JWK_OKP_Public<"EdDSA">): { kty: "OKP"; crv: "Ed25519"; x: string } {
  return { kty: "OKP", crv: "Ed25519", x: key?.x ?? "AAAA" };
}

async function trustAdmin(id: string): Promise<void> {
  await trustOperator(clock.ctx, { id, publicKey: publicHalf(), role: "admin" });
}

async function registerMachine(): Promise<{ id: string }> {
  return registerNode(clock.ctx, {
    v: 1,
    id: NODE_ID,
    publicKey: publicHalf(),
    addresses: { internal: NODE_ADDRESS, apiPort: 7400 },
  });
}

function nodeApp(): ReturnType<typeof createNodeApp> {
  return createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    version: VERSION,
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
    onExit: () => {},
  };
}
