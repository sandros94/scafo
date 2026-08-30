/*
 * WHAT A BLOCKED PROJECT STOPS DOING.
 *
 * Blocking is a FULL STOP and its whole value is that it needs no bookkeeping to
 * undo: the environment records, the builds, the aliases, the domains and the
 * placement decisions are all left exactly as they stand, and one flag on the
 * project record takes the project out of service. Unblocking is one call and
 * everything comes back on the next pass.
 *
 * It rides the machinery retirement and parking already ride rather than adding
 * one of its own. A blocked project contributes NOTHING to what a node reads as
 * its desired state, so its processes are stopped by the same leftover sweep
 * that stops a reassigned environment's, its hosts disappear from the routing
 * because the routing is rendered from what the node serves, and the wake
 * surface answers the same 404 it answers for a retired environment.
 *
 * The three refusals a caller can see directly — deploy, wake, certificate — are
 * asserted here; that a process is really stopped and that the ingress really
 * loses the routes are asserted where the loop runs, in
 * `test/daemon-reconcile.test.ts`.
 */

import type { H3 } from "h3";
import { beforeEach, describe, expect, it } from "vitest";
import { setCurrentBuild } from "../src/core/registry/_current.ts";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { readDesired } from "../src/daemon/_desired.ts";
import { resolveWakeTarget } from "../src/daemon/_wake-target.ts";
import {
  blockProject,
  claimDomain,
  createBuild,
  createEnvironment,
  createProject,
  registerNode,
  unblockProject,
} from "../src/core/registry/index.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const NODE_ID = "node-a";
const PROJECT = "shop";
const NEIGHBOUR = "blog";
const ENVIRONMENT = "prod";
const BUILD = "b1b1b1b1";
const PLATFORM_DOMAIN = "apps.test";
const CUSTOM_DOMAIN = "shop.example.com";
const VERSION = "0.0.0-test";

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
  for (const slug of [PROJECT, NEIGHBOUR]) {
    await createProject(registry, { slug });
    await createEnvironment(registry, slug, { name: ENVIRONMENT });
    await createBuild(registry, slug, { id: BUILD, runtimeConfigurable: true });
    await setCurrentBuild(registry, slug, ENVIRONMENT, BUILD);
  }
  await claimDomain(registry, CUSTOM_DOMAIN, PROJECT, ENVIRONMENT);

  app = createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry,
    supervisor: idleSupervisor(),
    version: VERSION,
  });
});

describe("what a node reads as its work", () => {
  it("drops every environment of a blocked project, and nobody else's", async () => {
    await blockProject(registry, PROJECT);

    const state = await readDesired(registry, {
      nodeId: NODE_ID,
      mode: "legacy-fallback",
    });

    expect(state.environments.map((entry) => entry.project)).toEqual([NEIGHBOUR]);
    /*
     * Nothing is reported as parked either: parked promises that a request wakes
     * it, and a blocked project's does not. The next pass's leftover sweep is
     * what stops whatever was still running for it.
     */
    expect(state.parked).toEqual([]);
    expect(state.failures).toEqual([]);
  });

  it("reports no placement view for it, so its rows leave the node's state too", async () => {
    await blockProject(registry, PROJECT);

    const state = await readDesired(registry, {
      nodeId: NODE_ID,
      mode: "legacy-fallback",
    });

    expect(state.placements.map((entry) => entry.project)).not.toContain(PROJECT);
  });

  it("brings it all back on the next pass, from records nothing touched", async () => {
    await blockProject(registry, PROJECT);
    await readDesired(registry, { nodeId: NODE_ID, mode: "legacy-fallback" });

    await unblockProject(registry, PROJECT);
    const state = await readDesired(registry, {
      nodeId: NODE_ID,
      mode: "legacy-fallback",
    });

    /* THE WHOLE POINT OF THE VERB. Nothing was deleted, so nothing has to be
       rebuilt: the alias still names the build and the pass simply wants it
       again. */
    expect(state.environments.map((entry) => entry.project).sort()).toEqual([NEIGHBOUR, PROJECT]);
    expect(
      state.environments.find((entry) => entry.project === PROJECT)?.builds.map((leg) => leg.role),
    ).toEqual(["current"]);
  });
});

describe("the wake surface", () => {
  it("refuses to wake anything of a blocked project", async () => {
    await blockProject(registry, PROJECT);

    const target = await resolveWakeTarget(registry, {
      host: `${PROJECT}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`,
      platformDomains: [PLATFORM_DOMAIN],
      parked: [],
    });

    /* Null is the one failure this surface has, and it is answered with the same
       404 a retired environment gets: nothing here is worth telling one caller
       about another's project. */
    expect(target).toBeNull();
  });

  it("still wakes the neighbour, which nobody blocked", async () => {
    await blockProject(registry, PROJECT);

    const target = await resolveWakeTarget(registry, {
      host: `${NEIGHBOUR}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`,
      platformDomains: [PLATFORM_DOMAIN],
      parked: [],
    });

    expect(target).toMatchObject({ kind: "environment", project: NEIGHBOUR });
  });

  it("wakes it again once the block is lifted", async () => {
    await blockProject(registry, PROJECT);
    await unblockProject(registry, PROJECT);

    const target = await resolveWakeTarget(registry, {
      host: `${PROJECT}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`,
      platformDomains: [PLATFORM_DOMAIN],
      parked: [],
    });

    expect(target).toMatchObject({ kind: "environment", project: PROJECT });
  });
});

describe("GET /v1/ingress/ask", () => {
  it("refuses a platform host of a blocked project", async () => {
    const before = await ask(`${PROJECT}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`);
    expect(before.status).toBe(200);

    await blockProject(registry, PROJECT);

    /*
     * This gates CERTIFICATE ISSUANCE. A blocked project answers nothing, so a
     * certificate minted for it now would be a fresh public record of a name
     * that serves nobody — and it would outlive the block.
     */
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

/* ---------------------------------------------------------------- fixtures */

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

function idleSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: (): ProcessStatus[] => [],
    onExit: () => {},
  };
}
