/* Default-deny operator tenancy and scoped fleet disclosure. */

import type { H3 } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { beforeEach, describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import { createNodeApp, type DaemonState } from "../src/daemon/app.ts";
import type { AssignmentResult } from "../src/daemon/_assign.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import type { Coordinator, CoordinatorStatus } from "../src/daemon/coordinator.ts";
import type { DeployMeta, DeployService, DeployStatus } from "../src/daemon/deploys.ts";
import type { OperatorsResult } from "../src/daemon/_operator-routes.ts";
import type { Reconciler, ReconcileStatus } from "../src/daemon/reconcile.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import { registerOperatorKey } from "../src/cli/_operator-key.ts";
import {
  acquireLease,
  createBuild,
  createEnvironment,
  createProject,
  registerNode,
} from "../src/core/registry/index.ts";
import { getOperator } from "../src/core/registry/operators.ts";
import { putJson } from "../src/core/registry/cas.ts";
import { operatorKey } from "../src/core/registry/paths.ts";
import type { OperatorRecord } from "../src/core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { createFileArtifactStager } from "../src/drivers/artifact/file.ts";
import { DEPLOY_METADATA_HEADER, encodeDeployMetadata } from "../src/daemon/_intake.ts";
import { ctxWith, type ManualClock, TEST_VERSIONS } from "./_helpers.ts";

const NODE_ID = "node-a";

/** The tenant's own project, and the one next door that is none of its business. */
const MINE = "acme";
const THEIRS = "globex";
const ENVIRONMENT = "prod";
const BUILD = "aaaa1111";

const ADMIN_ID = "op-admin111";
/** An operator-tier key scoped to {@link MINE} and to nothing else. */
const TENANT_ID = "op-tenant11";
/** An operator-tier key that says "every project" out loud. */
const WILD_ID = "op-wild1111";
/**
 * An operator-tier record carrying no projects, written straight into the bucket
 * by hand — the only way one can exist once every grant refuses to make one.
 */
const ORPHAN_ID = "op-orphan11";
/** Another tenant's key, which no tenant may learn about. */
const FOREIGN_ID = "op-foreign1";

type Keypair = { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };

let clock: ManualClock;
let node: Keypair;
let admin: Keypair;
let tenant: Keypair;
let wild: Keypair;
let orphan: Keypair;
let foreign: Keypair;
let deploys: StubDeploys;
let app: H3;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  node = await generateJWK("EdDSA", { kid: NODE_ID });
  admin = await generateJWK("EdDSA", { kid: ADMIN_ID });
  tenant = await generateJWK("EdDSA", { kid: TENANT_ID });
  wild = await generateJWK("EdDSA", { kid: WILD_ID });
  orphan = await generateJWK("EdDSA", { kid: ORPHAN_ID });
  foreign = await generateJWK("EdDSA", { kid: FOREIGN_ID });

  await registerNode(clock.ctx, {
    v: 1,
    id: NODE_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: node.publicKey.x },
    addresses: { internal: "10.0.0.4", apiPort: 7400 },
  });
  await fileKey(ADMIN_ID, admin, { role: "admin" });
  await fileKey(TENANT_ID, tenant, { role: "operator", projects: [MINE] });
  await fileKey(WILD_ID, wild, { role: "operator", projects: ["*"] });
  await fileKey(ORPHAN_ID, orphan, { role: "operator" });
  await fileKey(FOREIGN_ID, foreign, { role: "operator", projects: [THEIRS] });

  for (const project of [MINE, THEIRS]) {
    await createProject(clock.ctx, { slug: project });
    await createEnvironment(clock.ctx, project, { name: ENVIRONMENT });
    await createBuild(clock.ctx, project, { id: BUILD });
    await recordDeployment(clock.ctx, project, ENVIRONMENT, BUILD);
  }

  deploys = stubDeploys();
  app = createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: bothProjectsRunning(),
    versions: TEST_VERSIONS,
    reconciler: bothProjectsReconciled(),
    coordinator: coordinatorWithUnplaced(),
    deploys,
    artifactStager: createFileArtifactStager(),
  });
});

describe("an operator-tier key naming no projects reaches nothing at all", () => {
  it("is refused an environment route on EVERY project, its own included", async () => {
    for (const project of [MINE, THEIRS]) {
      const response = await call(pathIn(project, "/retire"), ORPHAN_ID, orphan, {
        method: "POST",
      });

      expect(response.status, project).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    }
  });

  it("is refused a deploy into every project", async () => {
    for (const project of [MINE, THEIRS]) {
      expect((await upload(ORPHAN_ID, orphan, project)).status, project).toBe(403);
    }
    expect(deploys.started).toEqual([]);
  });

  it("is refused the status of a deploy in every project", async () => {
    const started = deploys.recordFor(MINE);

    const response = await call(`/v1/deploys/${started.id}`, ORPHAN_ID, orphan, { method: "GET" });

    expect(response.status).toBe(403);
  });

  it("STILL AUTHENTICATES, because repair has to stay possible", async () => {
    const response = await call("/v1/operators", ORPHAN_ID, orphan, { method: "GET" });

    expect(response.status).toBe(200);
  });

  it("can rotate ITSELF, which is a carry-over rather than a grant", async () => {
    const minted = await generateJWK("EdDSA", { kid: "op-heir1111" });

    const response = await enroll(ORPHAN_ID, orphan, {
      ...publicHalf("op-heir1111", minted),
      supersedes: ORPHAN_ID,
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const heir = await getOperator(clock.ctx, "op-heir1111");
    expect(heir?.projects).toBeUndefined();
    expect((await upload("op-heir1111", minted, MINE)).status).toBe(403);
  });

  it("can be revoked by an admin, which is how the record is repaired", async () => {
    const response = await call(`/v1/operators/${ORPHAN_ID}`, ADMIN_ID, admin, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    await expect(getOperator(clock.ctx, ORPHAN_ID)).resolves.toBeNull();
  });

  it("leaves an ADMIN and a NODE reaching every project, because neither is a tenant", async () => {
    for (const project of [MINE, THEIRS]) {
      expect((await upload(ADMIN_ID, admin, project)).status, project).toBe(202);

      const asNode = await call(pathIn(project, "/retire"), NODE_ID, node, { method: "POST" });
      expect(asNode.status, project).toBe(200);
    }
  });
});

describe("enrolling an operator-tier key must NAME what it reaches", () => {
  it("refuses an admin enrolling an operator with no scope at all", async () => {
    const response = await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", await minted()),
      role: "operator",
    });

    expect(response.status).toBe(400);
    const problem = (await response.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("urn:scafo:invalid-input");
    expect(problem.detail).toContain("*");
    await expect(getOperator(clock.ctx, "op-joiner11")).resolves.toBeNull();
  });

  it("refuses a scope naming no project", async () => {
    const response = await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", await minted()),
      role: "operator",
      projects: [],
    });

    expect(response.status).toBe(400);
    await expect(getOperator(clock.ctx, "op-joiner11")).resolves.toBeNull();
  });

  it('refuses "*" MIXED with named projects, rather than guessing which was meant', async () => {
    const response = await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", await minted()),
      role: "operator",
      projects: ["*", MINE],
    });

    expect(response.status).toBe(400);
    const problem = (await response.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("urn:scafo:invalid-input");
    await expect(getOperator(clock.ctx, "op-joiner11")).resolves.toBeNull();
  });

  it("REFUSES THE SAME THING THROUGH THE BUCKET CEREMONY, which bypasses no rule here", async () => {
    await expect(
      registerOperatorKey(
        clock.ctx,
        {
          id: "op-joiner11",
          publicKey: { kty: "OKP", crv: "Ed25519", x: (await minted()).publicKey.x },
        },
        { role: "operator" },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(getOperator(clock.ctx, "op-joiner11")).resolves.toBeNull();
  });

  it("lets the ceremony seed an ADMIN, which names no projects and never could", async () => {
    const fresh = ctxWith(new MemoryCasStore());
    const role = await registerOperatorKey(fresh.ctx, {
      id: "op-first111",
      publicKey: { kty: "OKP", crv: "Ed25519", x: (await minted()).publicKey.x },
    });

    expect(role).toBe("admin");
  });
});

describe('["*"] is how a key says "every project" out loud', () => {
  it("reaches every project of the fleet", async () => {
    for (const project of [MINE, THEIRS]) {
      expect((await upload(WILD_ID, wild, project)).status, project).toBe(202);

      const response = await call(pathIn(project, "/retire"), WILD_ID, wild, { method: "POST" });
      expect(response.status, project).toBe(200);
    }
  });

  it("takes an ADMIN to grant fresh, so a wildcard key cannot mint another beside itself", async () => {
    const response = await enroll(WILD_ID, wild, {
      ...publicHalf("op-joiner11", await minted()),
      role: "operator",
      projects: ["*"],
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    await expect(getOperator(clock.ctx, "op-joiner11")).resolves.toBeNull();
  });

  it("is granted by an admin, and the record says so rather than saying nothing", async () => {
    const response = await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", await minted()),
      role: "operator",
      projects: ["*"],
    });

    expect(response.status).toBe(200);
    await expect(getOperator(clock.ctx, "op-joiner11")).resolves.toMatchObject({
      role: "operator",
      projects: ["*"],
    });
  });

  it("survives a rotation, because inheritance is never a widening", async () => {
    const heir = await generateJWK("EdDSA", { kid: "op-heir1111" });

    const response = await enroll(WILD_ID, wild, {
      ...publicHalf("op-heir1111", heir),
      supersedes: WILD_ID,
    });

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(getOperator(clock.ctx, "op-heir1111")).resolves.toMatchObject({
      role: "operator",
      supersedes: WILD_ID,
      projects: ["*"],
    });
  });

  it("is beyond a NARROWLY scoped key, which cannot rotate its way into it", async () => {
    const response = await enroll(TENANT_ID, tenant, {
      ...publicHalf("op-heir1111", await minted()),
      supersedes: TENANT_ID,
      projects: ["*"],
    });

    expect(response.status).toBe(403);
    await expect(getOperator(clock.ctx, "op-heir1111")).resolves.toBeNull();
  });
});

describe("GET /v1/operators shows an operator its OWN LINEAGE and nothing else", () => {
  it("answers the caller's record, the one it supersedes, and its pending successor", async () => {
    await fileKey(TENANT_ID, tenant, {
      role: "operator",
      projects: [MINE],
      supersedes: "op-before11",
    });
    await fileKey("op-before11", await minted(), { role: "operator", projects: [MINE] });
    await fileKey("op-after111", await minted(), {
      role: "operator",
      projects: [MINE],
      supersedes: TENANT_ID,
    });

    const body = await listing(TENANT_ID, tenant);

    expect(body.operators.map((entry) => entry.id).sort()).toEqual([
      "op-after111",
      "op-before11",
      TENANT_ID,
    ]);
  });

  it("hides every other tenant AND every admin, so nobody can be picked out to attack", async () => {
    const body = await listing(TENANT_ID, tenant);

    expect(body.operators.map((entry) => entry.id)).toEqual([TENANT_ID]);
    expect(body.operators.map((entry) => entry.id)).not.toContain(ADMIN_ID);
    expect(body.operators.map((entry) => entry.id)).not.toContain(FOREIGN_ID);
  });

  it("marks the answer as filtered, so a client never reads it as the whole set", async () => {
    const body = await listing(TENANT_ID, tenant);

    expect(body.scoped).toBe(true);
  });

  it("filters a WILDCARD key too, because scope is not tier", async () => {
    const body = await listing(WILD_ID, wild);

    expect(body.operators.map((entry) => entry.id)).toEqual([WILD_ID]);
    expect(body.scoped).toBe(true);
  });

  it("hands an ADMIN the whole set, with no marker on it", async () => {
    const body = await listing(ADMIN_ID, admin);

    expect(body.operators.map((entry) => entry.id)).toEqual([
      ADMIN_ID,
      FOREIGN_ID,
      ORPHAN_ID,
      TENANT_ID,
      WILD_ID,
    ]);
    expect(body.scoped).toBeUndefined();
  });

  it("still serves the confirm step of a rotation, which reads the caller's own lineage", async () => {
    const heir = await generateJWK("EdDSA", { kid: "op-heir1111" });
    await enroll(TENANT_ID, tenant, {
      ...publicHalf("op-heir1111", heir),
      supersedes: TENANT_ID,
    });

    const body = await listing("op-heir1111", heir);

    expect(body.operators.map((entry) => entry.id).sort()).toEqual(["op-heir1111", TENANT_ID]);
  });
});

describe("GET /v1/state is filtered to what the caller reaches", () => {
  it("hides another tenant's placements and processes", async () => {
    const state = await stateFor(TENANT_ID, tenant);

    expect(state.placements.map((entry) => entry.project)).toEqual([MINE]);
    expect(state.processes.map((entry) => entry.id)).toEqual([`${MINE}--${ENVIRONMENT}`]);
    expect(state.coordinator?.unplaced?.map((entry) => entry.target)).toEqual([
      `${MINE}/${ENVIRONMENT}`,
    ]);
    expect(state.reconcile?.placements.map((entry) => entry.project)).toEqual([MINE]);
    expect(state.reconcile?.processes.map((entry) => entry.project)).toEqual([MINE]);
  });

  it("keeps the machine facts, which belong to the node rather than to a tenant", async () => {
    const state = await stateFor(TENANT_ID, tenant);

    expect(state.node?.id).toBe(NODE_ID);
    expect(state.lease?.node).toBe(NODE_ID);
    expect(state.coordinator?.node).toBe(NODE_ID);
  });

  it("marks the answer as filtered whenever the caller is a non-admin operator", async () => {
    expect((await stateFor(TENANT_ID, tenant)).scoped).toBe(true);
    expect((await stateFor(WILD_ID, wild)).scoped).toBe(true);
    expect((await stateFor(ORPHAN_ID, orphan)).scoped).toBe(true);
  });

  it("shows a WILDCARD key every project, filtered by a filter that passes everything", async () => {
    const state = await stateFor(WILD_ID, wild);

    expect(state.placements.map((entry) => entry.project)).toEqual([MINE, THEIRS]);
    expect(state.processes).toHaveLength(2);
  });

  it("shows a scope-LESS operator-tier key nothing at all", async () => {
    const state = await stateFor(ORPHAN_ID, orphan);

    expect(state.placements).toEqual([]);
    expect(state.processes).toEqual([]);
    expect(state.coordinator?.unplaced).toBeUndefined();
  });

  it("hands a NODE-SIGNED PEER the whole state, unmarked, because the deploy hop needs it", async () => {
    const state = await stateFor(NODE_ID, node);

    expect(state.placements.map((entry) => entry.project)).toEqual([MINE, THEIRS]);
    expect(state.processes).toHaveLength(2);
    expect(state.coordinator?.unplaced).toHaveLength(2);
    expect(state.scoped).toBeUndefined();
  });

  it("hands an ADMIN the whole state, unmarked", async () => {
    const state = await stateFor(ADMIN_ID, admin);

    expect(state.placements.map((entry) => entry.project)).toEqual([MINE, THEIRS]);
    expect(state.processes).toHaveLength(2);
    expect(state.scoped).toBeUndefined();
  });
});

describe("a scoped operator can learn no foreign project name from this API", () => {
  it("finds none in the operator listing", async () => {
    const response = await call("/v1/operators", TENANT_ID, tenant, { method: "GET" });
    const body = await response.text();

    expect(body).not.toContain(THEIRS);
    expect(body).not.toContain(FOREIGN_ID);
  });

  it("finds none in the node's state", async () => {
    const response = await call("/v1/state", TENANT_ID, tenant, { method: "GET" });
    const body = await response.text();

    expect(body).not.toContain(THEIRS);
  });

  it("finds none in the refusal it gets for asking", async () => {
    const response = await call(pathIn(THEIRS, "/retire"), TENANT_ID, tenant, { method: "POST" });
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).toContain(THEIRS);
    expect(body).not.toContain(FOREIGN_ID);
  });
});

/** One call as the cases above state it: a method and, where there is one, a body. */
interface Call {
  method: string;
  body?: unknown;
}

/** The environment route `suffix` names, inside `project`. */
function pathIn(project: string, suffix: string): string {
  return `/v1/environments/${project}/${ENVIRONMENT}${suffix}`;
}

/** One call to the node, signed by `keys` for exactly this request. */
async function call(path: string, id: string, keys: Keypair, sent: Call): Promise<Response> {
  return app.request(path, {
    method: sent.method,
    headers: {
      "authorization": `Bearer ${await signNodeToken(keys.privateKey, id)}`,
      "content-type": "application/json",
    },
    ...(sent.body === undefined ? {} : { body: JSON.stringify(sent.body) }),
  });
}

/** The trusted-key listing as `id` reads it back. */
async function listing(id: string, keys: Keypair): Promise<OperatorsResult> {
  const response = await call("/v1/operators", id, keys, { method: "GET" });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as OperatorsResult;
}

/** The node's state as `id` reads it back. */
async function stateFor(id: string, keys: Keypair): Promise<DaemonState> {
  const response = await call("/v1/state", id, keys, { method: "GET" });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as DaemonState;
}

/** An artifact upload naming `project`, as a deploy client sends one. */
async function upload(id: string, keys: Keypair, project: string): Promise<Response> {
  return app.request(`/v1/projects/${project}/deploys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await signNodeToken(keys.privateKey, id)}`,
      [DEPLOY_METADATA_HEADER]: encodeDeployMetadata({}),
    },
    body: new Uint8Array([1, 2, 3]),
  });
}

/** One registration on `/v1/operators`, signed by `keys`. */
async function enroll(id: string, keys: Keypair, body: unknown): Promise<Response> {
  return call("/v1/operators", id, keys, { method: "POST", body });
}

/** A keypair nothing has filed, for the key a case is about to offer. */
async function minted(): Promise<Keypair> {
  return generateJWK("EdDSA", { kid: "op-joiner11" });
}

/** The public half of a keypair, as the trust route is given one. */
function publicHalf(id: string, keys: Keypair): Record<string, unknown> {
  return { id, publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x } };
}

/** Files a key as an operator's, straight into the registry — by hand, as the bucket's holder would. */
async function fileKey(
  id: string,
  keys: Keypair,
  operator?: { role: "admin" | "operator"; projects?: string[]; supersedes?: string },
): Promise<void> {
  await putJson<OperatorRecord>(clock.ctx, operatorKey(id), {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    ...operator,
  });
}

/** One running process per project, named the way the supervisor names them. */
function bothProjectsRunning(): Supervisor {
  const processes: ProcessStatus[] = [MINE, THEIRS].map((project) => ({
    id: `${project}--${ENVIRONMENT}`,
    state: "running",
    pid: 4321,
    startedAt: "2026-01-01T00:00:00.000Z",
  }));

  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: (): ProcessStatus[] => processes,
    forget: () => {},
    onExit: () => {},
  };
}

/** A reconcile loop that has read both projects. */
function bothProjectsReconciled(): Reconciler {
  const status: ReconcileStatus = {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    running: false,
    lastActions: [],
    failures: [],
    processes: [MINE, THEIRS].map((project) => ({
      processId: `${project}--${ENVIRONMENT}`,
      project,
      env: ENVIRONMENT,
      port: 42_001,
      internalPort: 42_002,
    })),
    placements: [MINE, THEIRS].map((project) => ({
      project,
      env: ENVIRONMENT,
      nodes: [NODE_ID],
      self: true,
    })),
  };

  return {
    runOnce: () => Promise.resolve([]),
    kick: () => {},
    start: () => {},
    shutdown: () => Promise.resolve(),
    stop: () => {},
    status: (): ReconcileStatus => status,
    /* A pass has finished and the fleet answers on nothing — not the absence of
       one, which no route under test reads. */
    fleetRouting: () => ({ v: 1, routes: [] }),
  };
}

/** A coordinator holding this node's lease, with one unplaced environment per project. */
function coordinatorWithUnplaced(): Coordinator {
  const lastAssignment: AssignmentResult = {
    live: [NODE_ID],
    changed: [],
    removed: [],
    skipped: [],
    unplaced: [MINE, THEIRS].map((project) => ({
      target: `${project}/${ENVIRONMENT}`,
      reason: "placement-unavailable",
      detail: `no live node carries the labels ${project}/${ENVIRONMENT} requires`,
    })),
  };
  const status: CoordinatorStatus = {
    holding: true,
    lease: null,
    lastReapAt: null,
    lastReapFailure: null,
    lastAssignAt: "2026-01-01T00:00:00.000Z",
    lastAssignment,
    lastAssignFailure: null,
  };

  return {
    start: () => {},
    stop: () => Promise.resolve(),
    runOnce: () => Promise.resolve(),
    status: (): CoordinatorStatus => status,
    handle: () => null,
  };
}

interface StubDeploys extends DeployService {
  /** Every meta the route handed over, in order. */
  started: DeployMeta[];
  /** Records a deploy for `project` without going through the route. */
  recordFor(project: string): DeployStatus;
}

/** A deploy intake that records what it was asked for and publishes nothing. */
function stubDeploys(): StubDeploys {
  const started: DeployMeta[] = [];
  const byId = new Map<string, DeployStatus>();
  let next = 0;

  const record = (project: string): DeployStatus => {
    next += 1;
    const status: DeployStatus = {
      /* A deploy id names the project it belongs to; a poll is authenticated
         against that project before anything is read. */
      id: `${project}.000000000000000${String(next)}`,
      project,
      state: "accepted",
    };
    byId.set(status.id, status);
    return status;
  };

  return {
    started,
    recordFor: record,
    reserve: () => ({
      project: "stub",
      signal: new AbortController().signal,
      cancel: () => {},
      discard: () => Promise.resolve(),
      enqueue: () => {
        throw new Error("stub admission consumes artifacts directly");
      },
    }),
    admit: (meta) => {
      started.push(meta);
      return Promise.resolve({
        start: (artifact) => {
          void artifact.dispose();
          return Promise.resolve(record(meta.project));
        },
      });
    },
    get: (id) => byId.get(id) ?? null,
    stop: () => Promise.resolve(),
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

beforeEach(async () => {
  await acquireLease(clock.ctx, NODE_ID);
});
