/* Effects of blocking and unblocking a project. */

import type { H3 } from "h3";
import { beforeEach, describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { readDesired } from "../src/daemon/_desired.ts";
import {
  acquireLease,
  blockProject,
  claimDomain,
  createBuild,
  createEnvironment,
  createProject,
  registerNode,
  unblockProject,
  writePlacement,
} from "../src/core/registry/index.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, TEST_VERSIONS } from "./_helpers.ts";

const NODE_ID = "node-a";
const PROJECT = "shop";
const NEIGHBOUR = "blog";
const ENVIRONMENT = "prod";
const BUILD = "b1b1b1b1";
const PLATFORM_DOMAIN = "apps.test";
const CUSTOM_DOMAIN = "shop.example.com";

let clock: ManualClock;
let registry: RegistryContext;
let app: H3;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  registry = clock.ctx;

  await registerNode(registry, {
    v: 1,
    id: NODE_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: "AAAA" },
    addresses: { internal: "10.0.0.4", apiPort: 7400 },
  });
  const lease = await acquireLease(registry, NODE_ID);
  if (lease === null) throw new Error("the fixture could not take the lease");
  for (const slug of [PROJECT, NEIGHBOUR]) {
    await createProject(registry, { slug });
    await createEnvironment(registry, slug, { name: ENVIRONMENT });
    await createBuild(registry, slug, { id: BUILD });
    await recordDeployment(registry, slug, ENVIRONMENT, BUILD);
    await writePlacement(registry, slug, ENVIRONMENT, [NODE_ID], lease);
  }
  await claimDomain(registry, CUSTOM_DOMAIN, PROJECT, ENVIRONMENT);

  app = createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry,
    supervisor: idleSupervisor(),
    versions: TEST_VERSIONS,
  });
});

describe("what a node reads as its work", () => {
  it("drops every environment of a blocked project, and nobody else's", async () => {
    await blockProject(registry, PROJECT);

    const state = await readDesired(registry, { nodeId: NODE_ID });

    expect(state.environments.map((entry) => entry.project)).toEqual([NEIGHBOUR]);
    expect(state.fleet.map((entry) => entry.project)).toEqual([NEIGHBOUR]);
  });

  it("reports no placement view for it, so its rows leave the node's state too", async () => {
    await blockProject(registry, PROJECT);

    const state = await readDesired(registry, { nodeId: NODE_ID });

    expect(state.placements.map((entry) => entry.project)).not.toContain(PROJECT);
  });

  it("brings it all back on the next pass, from records nothing touched", async () => {
    await blockProject(registry, PROJECT);
    await readDesired(registry, { nodeId: NODE_ID });

    await unblockProject(registry, PROJECT);
    const state = await readDesired(registry, { nodeId: NODE_ID });

    expect(state.environments.map((entry) => entry.project).sort()).toEqual([NEIGHBOUR, PROJECT]);
    expect(state.environments.find((entry) => entry.project === PROJECT)?.env.name).toBe(
      ENVIRONMENT,
    );
  });
});

describe("GET /v1/ingress/ask", () => {
  it("refuses a platform host of a blocked project", async () => {
    const before = await ask(`${PROJECT}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`);
    expect(before.status).toBe(200);

    await blockProject(registry, PROJECT);

    expect((await ask(`${PROJECT}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`)).status).toBe(404);
  });

  it("refuses a custom domain claimed by a blocked project's environment", async () => {
    expect((await ask(CUSTOM_DOMAIN)).status).toBe(200);

    await blockProject(registry, PROJECT);

    expect((await ask(CUSTOM_DOMAIN)).status).toBe(404);
  });

  it("answers for both again once the block is lifted", async () => {
    await blockProject(registry, PROJECT);
    await unblockProject(registry, PROJECT);

    expect((await ask(CUSTOM_DOMAIN)).status).toBe(200);
    expect((await ask(`${PROJECT}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`)).status).toBe(200);
  });

  it("leaves the fleet's own apex alone, which is not a project's name", async () => {
    await blockProject(registry, PROJECT);

    expect((await ask(PLATFORM_DOMAIN)).status).toBe(200);
  });
});

async function ask(domain: string): Promise<Response> {
  return app.request(`/v1/ingress/ask?domain=${domain}`);
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
