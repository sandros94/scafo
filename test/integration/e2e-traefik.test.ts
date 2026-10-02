/* End-to-end Traefik pull-ingress path. Traffic reflects node routing after the provider polls it. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DaemonState } from "../../src/daemon/app.ts";
import type { OperatorKeyFile } from "../../src/cli/_operator-key.ts";
import { signNodeToken } from "../../src/core/auth/node-token.ts";
import {
  getApplication,
  listDeployments,
  nodeKey,
  operatorKey as operatorRecordKey,
  readJson,
  readMeta,
  type RegistryContext,
} from "../../src/core/registry/index.ts";
import type { NodeRecord, OperatorRecord } from "../../src/core/types/registry.ts";
import type { TraefikDynamicConfig } from "../../src/drivers/ingress/traefik.ts";
import {
  NODE_IMAGE,
  BOOT_DEADLINE_MS,
  type BucketSettings,
  collectLogs,
  type CommandResult,
  DEADLINE_MS,
  deploymentOf,
  FIXTURES,
  type HttpAnswer,
  httpGet,
  registryAt,
  REPO_ROOT,
  runCli,
  SETUP_TIMEOUT_MS,
  stageApp,
  type StartedStore,
  startExplained,
  startStore,
  STEP_TIMEOUT_MS,
  storeEnv,
  until,
} from "./_harness.ts";

const E2E = process.env.SCAFO_E2E === "1";

const TRAEFIK_IMAGE = "traefik:v3";

const TRAEFIK_HTTP_PORT = 80;
/** Carries Traefik's own API and its ping; the suite reads both from the host. */
const TRAEFIK_API_PORT = 8080;
/** Published on the Traefik container, because the daemon shares its namespace. */
const NODE_PORT = 7400;

const BUCKET: BucketSettings = {
  bucket: "scafo-e2e-traefik",
  prefix: "e2e",
  accessKey: "scafo",
  secretKey: "scafo-secret",
  region: "us-east-1",
};

const PLATFORM_DOMAIN = "scafo.test";
/** A host of the operator's own, outside every platform domain this node serves. */
const CUSTOM_HOST = "shop.custom.test";
/** The application this suite deploys, and the name its `wrangler.jsonc` carries. */
const APPLICATION = "app";
const NODE_ID = "node-e2e-traefik";
/**
 * Supplied rather than minted: Traefik starts before the node and has to
 * present the token from its first poll, so both sides are told the same one.
 */
const INGRESS_TOKEN = "e2e-traefik-ingress-token";

/** What the suite presents where Traefik would. */
const INGRESS_HEADERS = { authorization: `Bearer ${INGRESS_TOKEN}` };

/**
 * The routers this node publishes whatever it is serving: the pair that answers
 * the fleet's API at the domain's own apex — the second of which
 * is what keeps `/v1/storage` off that public name.
 */
const STANDING_ROUTERS = [`scafo_api_${PLATFORM_DOMAIN}`, `scafo_apideny_${PLATFORM_DOMAIN}`];

let store: StartedStore;
let traefik: StartedTestContainer;
let daemon: StartedTestContainer;

let httpPort: number;
let traefikApiPort: number;
let apiPort: number;

let registry: RegistryContext;
let keyPath: string;
let operatorKey: OperatorKeyFile;
let versionV1: string;
let versionV2: string;

const tmpDirs: string[] = [];
/** Daemon output retained for failure context. */
const daemonLog: string[] = [];
/** Raw observations the report is written from; printed once at the end. */
const observed: Record<string, unknown> = {};

describe.skipIf(!E2E)("the single-node product loop through Traefik", () => {
  beforeAll(async () => {
    store = await startStore(BUCKET);

    const staticConfig = (await readFile(join(FIXTURES, "traefik.yml"), "utf8")).replace(
      "${SCAFO_INGRESS_TOKEN}",
      INGRESS_TOKEN,
    );
    traefik = await new GenericContainer(TRAEFIK_IMAGE)
      .withCopyContentToContainer([{ content: staticConfig, target: "/etc/traefik/traefik.yml" }])
      .withExposedPorts(TRAEFIK_HTTP_PORT, TRAEFIK_API_PORT, NODE_PORT)
      .withWaitStrategy(Wait.forHttp("/ping", TRAEFIK_API_PORT).forStatusCode(200))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    httpPort = traefik.getMappedPort(TRAEFIK_HTTP_PORT);
    traefikApiPort = traefik.getMappedPort(TRAEFIK_API_PORT);
    apiPort = traefik.getMappedPort(NODE_PORT);

    daemon = await startExplained(
      new GenericContainer(NODE_IMAGE)
        .withNetworkMode(`container:${traefik.getId()}`)
        .withBindMounts([{ source: REPO_ROOT, target: "/work", mode: "ro" }])
        .withWorkingDir("/work")
        .withEnvironment({
          ...storeEnv(store.fromContainers, BUCKET),
          SCAFO_NODE_ID: NODE_ID,
          SCAFO_TRANSPORT: "none",
          SCAFO_STATE_DIR: "/var/lib/scafo",
          SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
          SCAFO_INGRESS_TOKEN: INGRESS_TOKEN,
          SCAFO_ADVERTISE: `127.0.0.1:${String(NODE_PORT)}`,
          CELLD_ESBUILD: "/usr/local/bin/esbuild",
        })
        .withCommand([
          "node",
          "dist/cli/index.mjs",
          "sail",
          "--listen",
          `0.0.0.0:${String(NODE_PORT)}`,
        ])
        .withLogConsumer(collectLogs(daemonLog))
        .withWaitStrategy(Wait.forLogMessage(/listening on/))
        .withStartupTimeout(BOOT_DEADLINE_MS),
      { log: daemonLog, what: `node ${NODE_ID}` },
    );

    registry = registryAt(store.fromHost, BUCKET);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await traefik?.stop().catch(() => {});
    await store?.container.stop().catch(() => {});
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });

    console.log(`\n[e2e-traefik] raw observations\n${JSON.stringify(observed, null, 2)}`);
  }, SETUP_TIMEOUT_MS);

  it(
    "answers its health endpoint and has bootstrapped the registry in the bucket",
    async () => {
      const health = await wait(
        "the daemon to answer /.well-known/scafo/health",
        BOOT_DEADLINE_MS,
        async () => {
          const answer = await httpGet(apiPort, "/.well-known/scafo/health", {});
          return answer.status === 200 ? answer : null;
        },
      );
      expect(JSON.parse(health.body)).toMatchObject({ ok: true, node: NODE_ID });

      const meta = await readMeta(registry);
      expect(meta, "the registry the first node bootstraps").not.toBeNull();

      const node = await readJson<NodeRecord>(registry, nodeKey(NODE_ID));
      expect(node?.value.addresses).toMatchObject({ apiPort: NODE_PORT });
      observed.health = JSON.parse(health.body);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "refuses the routing until its first pass, then publishes the standing routers and nothing else",
    async () => {
      const unauthenticated = await httpGet(apiPort, "/v1/ingress/routes/traefik", {});
      expect(unauthenticated.status).toBe(401);

      /* A node that has not finished a reconcile pass refuses with 503
         `urn:scafo:draining` rather than answering: an empty configuration says
         the fleet answers on nothing, which Traefik's http provider acts on by
         withdrawing every router it holds, and a node that has just booted has
         not read enough to say that. Whether this suite catches the window is a
         race with that first pass — the refusals are recorded, never required —
         but the poll accepts nothing but a 200, so an emptiness read BEFORE the
         pass can never pass for the answer the pass gives. */
      const refused: HttpAnswer[] = [];
      const answer = await wait(
        "the node to know what the fleet answers on",
        DEADLINE_MS,
        async () => {
          const got = await httpGet(apiPort, "/v1/ingress/routes/traefik", INGRESS_HEADERS);
          if (got.status === 200) return got;
          refused.push(got);
          return null;
        },
      );

      /* Whatever it answered before that was the draining refusal, and nothing
         else: any other status is the node failing, not waiting. */
      for (const refusal of refused) {
        expect(refusal.status, refusal.body).toBe(503);
        expect(JSON.parse(refusal.body)).toMatchObject({ type: "urn:scafo:draining" });
      }

      /* What a finished pass over a fleet with nothing deployed publishes: the
         pair that answers the platform apex, and not one application router. */
      const snapshot = JSON.parse(answer.body) as TraefikDynamicConfig;
      expect(Object.keys(snapshot.http?.routers ?? {}).sort()).toEqual(
        [...STANDING_ROUTERS].sort(),
      );
      observed.standingSnapshot = answer.body;
      observed.drainingRefusals = refused.map((refusal) => refusal.body);

      /* And Traefik holds exactly that once it has polled: the standing pair is
         a published route like any other, not something the suite waits out. */
      const held = await wait(
        "Traefik to hold nothing but the standing routers",
        DEADLINE_MS,
        async () => {
          const routers = await scafoRouters();
          return routers.length === STANDING_ROUTERS.length ? routers : null;
        },
      );
      expect(held.sort()).toEqual([...STANDING_ROUTERS].map((name) => `${name}@http`).sort());
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "answers Traefik's native 404 for a host nothing owns",
    async () => {
      const answer = await wait(
        "an unknown host to fall through Traefik",
        DEADLINE_MS,
        async () => {
          const got = await httpGet(httpPort, "/", { host: "unrouted.scafo.test" });
          return got.status === 404 && got.body.includes("404 page not found") ? got : null;
        },
      );
      expect(answer).toMatchObject({ status: 404 });
      expect(answer.body).toContain("404 page not found");
      observed.routelessHost = { status: answer.status, body: answer.body };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "registers an operator key whose public half lands in the registry",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "scafo-e2e-traefik-key-"));
      tmpDirs.push(dir);
      keyPath = join(dir, "operator.json");

      const result = await runCli(
        ["operator", "keygen", "--out", keyPath, "--register"],
        storeEnv(store.fromHost, BUCKET),
      );
      expectCleanExit(result);

      operatorKey = JSON.parse(await readFile(keyPath, "utf8")) as OperatorKeyFile;
      const record = await readJson<OperatorRecord>(registry, operatorRecordKey(operatorKey.id));
      expect(record?.value.publicKey.x).toBe(operatorKey.publicKey.x);
      expect(await readJson(registry, nodeKey(operatorKey.id))).toBeNull();
      observed.operatorId = operatorKey.id;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "deploys the first version and reports it deployed",
    async () => {
      const started = Date.now();
      const result = await runCli(deployArgs(await staged("v1")), {});
      observed.deployV1Ms = Date.now() - started;
      observed.deployV1Output = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");

      versionV1 = deploymentOf(result.output);
      expect(await listDeployments(registry, APPLICATION)).toContain(versionV1);
      observed.versionV1 = versionV1;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "serves the first deployment through Traefik on the application's own host",
    async () => {
      const expected = [`scafo_${appHost()}`, ...STANDING_ROUTERS].sort();
      await wait("Traefik to hold the v1 router", DEADLINE_MS, async () => {
        const routers = (await scafoRouters()).sort();
        return routers.join(",") === expected.map((name) => `${name}@http`).join(",")
          ? routers
          : null;
      });

      const answer = await untilServes(appHost(), "v1");
      expect(JSON.parse(answer.body).url, `the url ${appHost()} saw`).toContain(appHost());

      const snapshot = await snapshotNow();
      expect(Object.keys(snapshot.http?.routers ?? {}).sort()).toEqual(expected);
      observed.v1Snapshot = snapshot;
      observed.v1TraefikRouters = await scafoRouters();
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "publishes a router for a claimed custom domain, serves its subdomains once the claim covers them, and withdraws both on release",
    async () => {
      const nodeFlags = ["--node", `http://127.0.0.1:${String(apiPort)}`, "--key", keyPath];
      const otherHost = `anything-else.${CUSTOM_HOST}`;

      const added = await runCli(
        ["app", "domain", "add", CUSTOM_HOST, "--name", APPLICATION, ...nodeFlags],
        {},
      );
      observed.domainAddOutput = added.output;
      expectCleanExit(added);
      /* The DNS helper ran and said one of the two things it can say; which one
         is the resolver's business rather than scafo's. */
      expect(added.output).toContain(CUSTOM_HOST);
      expect(added.output).toMatch(
        new RegExp(`already resolves to this installation|CNAME to "${appHost()}"`),
      );

      const exact = [`scafo_${appHost()}`, `scafo_${CUSTOM_HOST}`, ...STANDING_ROUTERS].sort();
      await wait("Traefik to hold the router for the claimed host", DEADLINE_MS, async () => {
        const routers = (await scafoRouters()).sort();
        return routers.join(",") === exact.map((name) => `${name}@http`).join(",") ? routers : null;
      });

      const answer = await untilServes(CUSTOM_HOST, "v1");
      expect(JSON.parse(answer.body).url, `the url ${CUSTOM_HOST} saw`).toContain(CUSTOM_HOST);
      observed.customDomainSnapshot = await snapshotNow();

      /* The same claim, re-added with `--wildcard`, now covers its subdomains. */
      const covered = await runCli(
        ["app", "domain", "add", CUSTOM_HOST, "--name", APPLICATION, "--wildcard", ...nodeFlags],
        {},
      );
      observed.wildcardAddOutput = covered.output;
      expectCleanExit(covered);
      expect(covered.output).toContain(`"<env>.${CUSTOM_HOST}"`);
      /* What the operator still has to do at the ingress, said once. */
      expect(covered.output).toContain("DNS-01");

      /* The base keeps its exact router, and everything else one label under it
         gets one more, which Traefik ranks below every exact `Host` router. */
      const wildcard = [...exact, `scafo_wild_${CUSTOM_HOST}`].sort();
      await wait("Traefik to hold the routers of a covered base", DEADLINE_MS, async () => {
        const routers = (await scafoRouters()).sort();
        return routers.join(",") === wildcard.map((name) => `${name}@http`).join(",")
          ? routers
          : null;
      });
      observed.wildcardSnapshot = await snapshotNow();

      /* Rule 1: the base itself is the application. */
      expect(JSON.parse((await untilServes(CUSTOM_HOST, "v1")).body).version).toBe("v1");
      /* Rule 3: any other single label falls to the application itself. */
      const other = await untilServes(otherHost, "v1");
      expect(JSON.parse(other.body).url).toContain(otherHost);
      /* One label and no more, so a deeper name is nobody's. */
      const deep = await httpGet(httpPort, "/", { host: `a.b.${CUSTOM_HOST}` });
      expect(deep.status).toBe(404);
      expect(deep.body).toContain("404 page not found");
      observed.wildcardServed = { base: "v1", other: "v1", deeper: deep.status };

      /* Releasing takes the whole claim, rules and all. */
      const removed = await runCli(
        ["app", "domain", "remove", CUSTOM_HOST, "--name", APPLICATION, ...nodeFlags],
        {},
      );
      observed.domainRemoveOutput = removed.output;
      expectCleanExit(removed);

      const without = [`scafo_${appHost()}`, ...STANDING_ROUTERS].sort();
      await wait("Traefik to withdraw every router the claim added", DEADLINE_MS, async () => {
        const routers = (await scafoRouters()).sort();
        return routers.join(",") === without.map((name) => `${name}@http`).join(",")
          ? routers
          : null;
      });
      for (const host of [CUSTOM_HOST, otherHost]) {
        const gone = await wait(`${host} to stop being served`, DEADLINE_MS, async () => {
          const got = await httpGet(httpPort, "/", { host });
          return got.status === 404 ? got : null;
        });
        expect(gone.body, host).toContain("404 page not found");
      }

      /* And the host it was always served at is untouched throughout. */
      expect(JSON.parse((await untilServes(appHost(), "v1")).body).version).toBe("v1");
      observed.customDomain = { host: CUSTOM_HOST, servedThenReleased: true };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "answers the fleet's API at the domain's apex, and denies the colocated prefixes there",
    async () => {
      const health = await wait(
        `${PLATFORM_DOMAIN} to answer the daemon's health`,
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(httpPort, "/.well-known/scafo/health", {
            host: PLATFORM_DOMAIN,
          });
          return answer.status === 200 ? answer : null;
        },
      );
      expect(JSON.parse(health.body)).toMatchObject({ ok: true, node: NODE_ID });
      observed.apexHealth = JSON.parse(health.body);

      for (const path of [
        "/v1/storage",
        "/v1/storage/list?prefix=",
        "/v1/storage/objects/anything",
        "/v1/ingress/routes/traefik",
      ]) {
        const blocked = await httpGet(httpPort, path, { host: PLATFORM_DOMAIN });

        expect(blocked.status, `${path} through the apex`).toBe(418);
        expect(blocked.body, `${path} through the apex`).not.toContain("urn:scafo:");
      }
      observed.apexDeniedStatus = 418;

      const local = await httpGet(apiPort, "/v1/ingress/routes/traefik", INGRESS_HEADERS);
      expect(local.status).toBe(200);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "makes a second deployment current, and Traefik follows the published route",
    async () => {
      const result = await runCli(deployArgs(await staged("v2")), {});
      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");
      versionV2 = deploymentOf(result.output);
      expect(versionV2).not.toBe(versionV1);
      observed.versionV2 = versionV2;
      observed.deployV2Output = result.output;

      const publishedAt = Date.now();
      await wait(`the router for ${appHost()} to be published`, DEADLINE_MS, async () => {
        const routers = (await snapshotNow()).http?.routers ?? {};
        return `scafo_${appHost()}` in routers ? routers : null;
      });
      await untilServes(appHost(), "v2");
      observed.deployPublishedToServedMs = Date.now() - publishedAt;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "settles on exactly one application-owned runtime process",
    async () => {
      const state = await wait(
        "the node to report a single running process",
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(apiPort, "/v1/state", {
            authorization: `Bearer ${await operatorToken()}`,
          });
          if (answer.status !== 200) return null;

          const body = JSON.parse(answer.body) as DaemonState;
          const running = body.processes.filter((process) => process.state === "running");
          return running.length === 1 ? body : null;
        },
      );

      const running = state.processes.filter((process) => process.state === "running");
      expect(running[0].id).toBe(APPLICATION);
      expect(state.reconcile?.failures ?? []).toEqual([]);
      observed.finalProcesses = state.processes;
      observed.finalReconcile = state.reconcile;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "retires the application, and Traefik stops answering for it entirely",
    async () => {
      const retiredAt = Date.now();
      const retired = await runCli(
        [
          "app",
          "retire",
          "--name",
          APPLICATION,
          "--node",
          `http://127.0.0.1:${String(apiPort)}`,
          "--key",
          keyPath,
        ],
        {},
      );
      expectCleanExit(retired);
      expect(retired.output).toContain("retired");

      const settledAt = await wait(
        "the node to publish nothing but the standing routers",
        DEADLINE_MS,
        async () => {
          const routers = Object.keys((await snapshotNow()).http?.routers ?? { absent: true });
          return routers.every((name) => STANDING_ROUTERS.includes(name)) ? Date.now() : null;
        },
      );
      const gone = await wait(`${appHost()} to stop being served`, DEADLINE_MS, async () => {
        const answer = await httpGet(httpPort, "/", { host: appHost() });
        return answer.status === 404 ? answer : null;
      });
      observed.retireToStandingSnapshotMs = settledAt - retiredAt;
      observed.retireToUnroutedMs = Date.now() - retiredAt;
      expect(gone.body).toContain("404 page not found");

      const remaining = await scafoRouters();
      expect(remaining.sort()).toEqual([...STANDING_ROUTERS].map((name) => `${name}@http`).sort());

      const record = await getApplication(registry, APPLICATION);
      expect(record.retiredAt).toBeDefined();
      observed.retiredAt = record.retiredAt;
      observed.retiredSnapshot = await snapshotNow();
    },
    STEP_TIMEOUT_MS,
  );
});

/** The one host the application is served at under the platform domain. */
function appHost(): string {
  return `${APPLICATION}.${PLATFORM_DOMAIN}`;
}

/** The flags one deploy of the fixture is run with, from the host. */
function deployArgs(dir: string): string[] {
  return [
    "deploy",
    dir,
    "--node",
    `http://127.0.0.1:${String(apiPort)}`,
    "--name",
    APPLICATION,
    "--key",
    keyPath,
  ];
}

function staged(version: string): Promise<string> {
  return stageApp(version, tmpDirs);
}

/** A fresh single-use operator token; a spent one is refused as a replay. */
function operatorToken(): Promise<string> {
  return signNodeToken(operatorKey.privateKey, operatorKey.id);
}

/** The configuration the node is publishing for Traefik right now. */
async function snapshotNow(): Promise<TraefikDynamicConfig> {
  const answer = await httpGet(apiPort, "/v1/ingress/routes/traefik", INGRESS_HEADERS);
  expect(answer.status, answer.body).toBe(200);
  return JSON.parse(answer.body) as TraefikDynamicConfig;
}

/**
 * The routers Traefik currently holds from the http provider — its side of the
 * poll, read from its own API rather than inferred from what it serves.
 *
 * Names come back qualified with the provider that supplied them
 * (`scafo_shop.test@http`), which is Traefik's own convention and not something
 * the node writes.
 */
async function scafoRouters(): Promise<string[]> {
  const answer = await httpGet(traefikApiPort, "/api/http/routers", {});
  if (answer.status === 404) return [];
  expect(answer.status, `Traefik's API answered ${answer.body}`).toBe(200);

  const routers = JSON.parse(answer.body) as Array<{ name: string }>;
  return routers.map((router) => router.name).filter((name) => name.startsWith("scafo_"));
}

/** Polls one host through Traefik until it answers with the expected app version. */
function untilServes(host: string, version: string): Promise<HttpAnswer> {
  return wait(`${host} to serve "${version}"`, DEADLINE_MS, async () => {
    const answer = await httpGet(httpPort, "/", { host });
    if (answer.status !== 200) return null;
    return answer.body.includes(`"${version}"`) ? answer : null;
  });
}

/** {@link until} with the daemon's logs attached to whatever it fails to see. */
function wait<T>(what: string, deadlineMs: number, probe: () => Promise<T | null>): Promise<T> {
  return until(what, deadlineMs, probe, { context: daemonLogTail });
}

/** Fails with command output and daemon logs. */
function expectCleanExit(result: CommandResult): void {
  expect(result.code, `${result.output}\n${daemonLogTail()}`).toBe(0);
}

/** The tail of the daemon container's output, as a failure message carries it. */
function daemonLogTail(limit: number = 12_000): string {
  const text = daemonLog.join("");
  const tail = text.length <= limit ? text : `…${text.slice(-limit)}`;
  return `--- daemon container logs ---\n${tail}\n--- end daemon container logs ---`;
}
