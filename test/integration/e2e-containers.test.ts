/*
 * Container classes, end to end, through a node that only passes the engine on.
 *
 * SCAFO HANDS CELLD THE ENGINE AND NOTHING ELSE. There is no switch to turn on,
 * nothing about containers in a node's record, and no refusal of its own: a node
 * is given the machine's engine socket, Celld finds it the way Celld always
 * does, and an operator keeps container work on the machines that have one with
 * the labels and selectors this fleet already has. So this suite proves the two
 * things that are actually scafo's: an application whose deployment declares a
 * class reaches a labelled node, starts its container and answers from inside
 * it — and the same artifact sent to a node without an engine fails with
 * Celld's own words on the record, having published nothing.
 *
 * A CONTAINERIZED NODE NEEDS THE HOST'S NETWORK NAMESPACE. Celld reaches a
 * container from the host side of the bridges it creates (`celld0`, `celld1`),
 * and it fences those bridges with nftables rules that reject anything they send
 * into a private range — the node's own address included. A node in a network
 * namespace of its own is on the far side of both: its deploy succeeds, its
 * `start()` succeeds, the engine shows the container up, and every
 * `getTcpPort().fetch()` then hangs, because the container's replies are
 * rejected on the way back. That is why the node with the socket runs with
 * `--network host` here, and why an operator's containerized node must too.
 */

import { cp, mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deployPrefix,
  fleetPrefix,
  getDeployRecord,
  listDeployments,
  type RegistryContext,
} from "../../src/core/registry/index.ts";
import type { FleetRouting } from "../../src/core/types/ingress.ts";
import {
  BOOT_DEADLINE_MS,
  type BucketSettings,
  collectLogs,
  type CommandResult,
  DEADLINE_MS,
  deploymentOf,
  FIXTURES,
  httpGet,
  type HttpAnswer,
  registryAt,
  REPO_ROOT,
  run,
  runCli,
  SETUP_TIMEOUT_MS,
  type StartedStore,
  startExplained,
  startStore,
  storeEnv,
  until,
} from "./_harness.ts";

const E2E = process.env.SCAFO_E2E === "1";

/** The path Celld tries first, and the only one this suite mounts. */
const ENGINE_SOCKET = "/var/run/docker.sock";

/**
 * The group that owns the engine socket, or null when this host has none to
 * mount. An engine reached over TCP, or through a socket somewhere else, is not
 * one this suite can hand a node — it says so and skips rather than failing.
 */
function engineSocketGroup(): number | null {
  try {
    const stats = statSync(ENGINE_SOCKET);
    return stats.isSocket() ? stats.gid : null;
  } catch {
    return null;
  }
}

const SOCKET_GROUP: number | null = engineSocketGroup();
/** An engine this host reaches somewhere other than that socket, which cannot be mounted. */
const ELSEWHERE: string = (process.env.DOCKER_HOST ?? "").trim();
const MOUNTABLE: boolean =
  SOCKET_GROUP !== null && (ELSEWHERE === "" || ELSEWHERE === `unix://${ENGINE_SOCKET}`);

if (E2E && !MOUNTABLE) {
  console.log(
    `[e2e-containers] skipped: this host has no container engine socket at "${ENGINE_SOCKET}" ` +
      `to bind-mount into a node container${ELSEWHERE === "" ? "" : ` (DOCKER_HOST is "${ELSEWHERE}")`}`,
  );
}

/**
 * Tagged and KEPT, as the image suite does it, so a second run reuses it. The
 * PRODUCT image and not the probe the other suites bind-mount a build into: the
 * node that takes a deploy with a container class builds that image with the
 * engine client only the product image carries, and that client is part of what
 * this suite proves. The CLI the suite runs on the host is still the one the
 * global setup built.
 */
const IMAGE_TAG = "scafo-e2e-containers";
/** An image already in the local daemon, named by CI; unset, the suite builds. */
const PREBUILT_IMAGE: string = process.env.SCAFO_E2E_IMAGE ?? "";
const IMAGE_REF: string = PREBUILT_IMAGE === "" ? IMAGE_TAG : PREBUILT_IMAGE;

/**
 * NO INGRESS HERE: the node with the socket is in the host's namespace, where a
 * Caddy of this suite's own would fight for port 80. The application is reached
 * the way an ingress reaches it — by the upstream out of the node's own routing
 * document, which is also where the selector's work is visible.
 */
const INGRESS_TOKEN = "e2e-containers-ingress-token";

/**
 * WHOSE HOST NAMESPACE IT IS, is not always the machine running this suite:
 * Docker Desktop keeps the engine in a virtual machine, whose host ports this
 * process cannot dial though a container on a bridge reaches them at the
 * gateway. So every call into the host-networked node goes through one such
 * container forwarding one port — a plain hop on a Linux runner, and the only
 * way in on a developer's machine.
 */
const PROXY_SCRIPT = `
const net = require("node:net");
const [host, port] = process.env.TARGET.split(":");
net
  .createServer((from) => {
    const to = net.connect(Number(port), host);
    const stop = () => {
      from.destroy();
      to.destroy();
    };
    from.on("error", stop);
    to.on("error", stop);
    from.pipe(to);
    to.pipe(from);
  })
  .listen(Number(port), "0.0.0.0");
`;

/** The port the node in its own namespace publishes; the host-network one takes a free one. */
const NODE_PORT = 7400;

/** The uid the image runs as, with the socket's group in place of its own. */
const NODE_USER = `10001:${String(SOCKET_GROUP ?? 0)}`;

const BUCKET: BucketSettings = {
  bucket: "scafo-e2e-containers",
  prefix: "e2e",
  accessKey: "scafo",
  secretKey: "scafo-secret",
  region: "us-east-1",
};

const PLATFORM_DOMAIN = "scafo.test";

/** The machine with no engine under it: an ordinary node of the fleet. */
const NODE_PLAIN = "node-e2e-containers-plain";
/** The machine whose engine socket the operator mounted, and labelled to say so. */
const NODE_ENGINE = "node-e2e-containers-engine";

/**
 * What the operator writes on the machine that has an engine, and what the
 * application selects on. THE WHOLE PLACEMENT MECHANISM: scafo reports nothing
 * about engines, so the fleet knows which machines have one because its operator
 * said so.
 */
const ENGINE_LABEL = "containers=true";

/**
 * The engine client the node with no engine is told to run instead of `docker`.
 * The image ships no such binary, so the publish can only fail by naming it —
 * which is the proof that `CELLD_DOCKER` crossed from the daemon to the publish.
 */
const ENGINE_CLI_ELSEWHERE = "podman";

/**
 * The platform the engine node's publish is told to build for, on an amd64
 * engine host only. 386 IS THE ONE PLATFORM THAT PROVES THE KNOB CROSSED THE
 * PUBLISH WITHOUT EMULATION: an amd64 kernel runs 386 binaries natively, so the
 * image builds and the container still answers, yet its architecture is not the
 * `linux/amd64` Celld builds for when it is told nothing.
 */
const EXERCISED_PLATFORM = "linux/386";

/** Deployed through the labelled node, and served from it. */
const APP_SERVED = "sidecar";
/** Deployed through the node with no engine, where Celld cannot build the image. */
const APP_NO_ENGINE = "sidecar-no-engine";

/** The class the fixture attaches a container to; Celld labels the container with it. */
const CONTAINER_CLASS = "Sidecar";
/** The bridges Celld creates on the engine before the first container of a node starts. */
const CELLD_NETWORKS = ["celld", "celld-internal"];
/** The nftables table Celld installs on the HOST to fence those two bridges. */
const FENCE_TABLE = "inet celld";

/** Building an image and saving it to the bucket is the slowest step here. */
const DEPLOY_STEP_TIMEOUT_MS = 300_000;
/** Loading the image tar, fencing the bridges, and the container's own boot. */
const CONTAINER_DEADLINE_MS = 120_000;

let store: StartedStore;
let plain: StartedTestContainer;
let engine: StartedTestContainer;

let plainApiPort: number;
/** The port the host-networked node listens on, in the ENGINE host's namespace. */
let engineApiPort: number;
/** Where this process reaches that same listener, through a forwarder. */
let engineHostPort: number;
/** The engine host's architecture, which decides whether {@link EXERCISED_PLATFORM} is exercised. */
let engineArch: string;
/** The bridge gateway, which is the engine host seen from a container on it. */
let gateway: string;
const forwarders: StartedTestContainer[] = [];

let registry: RegistryContext;
let keyPath: string;

const tmpDirs: string[] = [];
const plainLog: string[] = [];
const engineLog: string[] = [];
/** Image references Celld built on the host engine, removed when the suite ends. */
const builtImages: string[] = [];
/** The fence image, which is also what runs `nft` to take the fence down again. */
let fenceImage: string | undefined;
/** The Celld node that started the container, by the label every container it starts carries. */
let celldNode: string | undefined;
/** Celld's bridges that were already on this engine, and are therefore not ours to remove. */
let keptNetworks: string[] = [];
/** Raw observations the report is written from; printed once at the end. */
const observed: Record<string, unknown> = {};

describe.skipIf(!E2E || !MOUNTABLE)("container classes, on a node given the host's engine", () => {
  beforeAll(async () => {
    const started = Date.now();
    if (PREBUILT_IMAGE === "") {
      await GenericContainer.fromDockerfile(REPO_ROOT, "Dockerfile")
        .withCache(true)
        .build(IMAGE_TAG, { deleteOnExit: false });
    }
    observed.imageRef = IMAGE_REF;
    observed.imageBuildMs = PREBUILT_IMAGE === "" ? Date.now() - started : null;
    observed.socket = { path: ENGINE_SOCKET, gid: SOCKET_GROUP, user: NODE_USER };

    /* Read BEFORE anything runs: a bridge that was already here belongs to
       whatever put it here, and the cleanup leaves it, its fence included. */
    keptNetworks = await celldNetworksPresent();
    observed.networksAlreadyHere = keptNetworks;

    store = await startStore(BUCKET);

    /* An ordinary node, in a namespace of its own with its port published: no
       socket, no label, and nothing about it that mentions containers. */
    plain = await startExplained(
      new GenericContainer(IMAGE_REF)
        .withEnvironment({
          ...nodeEnvironment(NODE_PLAIN, store.fromContainers),
          CELLD_DOCKER: ENGINE_CLI_ELSEWHERE,
          SCAFO_ADVERTISE: `127.0.0.1:${String(NODE_PORT)}`,
          SCAFO_LISTEN: `0.0.0.0:${String(NODE_PORT)}`,
        })
        .withExposedPorts(NODE_PORT)
        .withCommand(["sail"])
        .withLogConsumer(collectLogs(plainLog))
        .withWaitStrategy(Wait.forLogMessage(/listening on/))
        .withStartupTimeout(BOOT_DEADLINE_MS),
      { log: plainLog, what: `node ${NODE_PLAIN}` },
    );
    plainApiPort = plain.getMappedPort(NODE_PORT);

    /*
     * The machine with the engine: its socket mounted, the socket's group as
     * the container's own, the label that says what it is, and the host's
     * network namespace, which is what lets Celld reach what it starts. The
     * ports it and its runtime processes bind are therefore the engine host's:
     * taken free, high, and wider than loopback so the forwarder reaches them.
     */
    gateway = (
      await docker([
        "network",
        "inspect",
        "bridge",
        "--format",
        "{{(index .IPAM.Config 0).Gateway}}",
      ])
    ).output.trim();
    engineArch = (await docker(["version", "--format", "{{.Server.Arch}}"])).output.trim();
    engineApiPort = await freePort();
    const runtimePort = await freePort();
    engine = await startExplained(
      new GenericContainer(IMAGE_REF)
        .withNetworkMode("host")
        .withEnvironment({
          ...nodeEnvironment(NODE_ENGINE, store.fromHost),
          SCAFO_NODE_LABELS: ENGINE_LABEL,
          SCAFO_INGRESS_TOKEN: INGRESS_TOKEN,
          SCAFO_ADVERTISE: `127.0.0.1:${String(engineApiPort)}`,
          SCAFO_LISTEN: `0.0.0.0:${String(engineApiPort)}`,
          SCAFO_BIND_HOST: "0.0.0.0",
          SCAFO_PORT_RANGE_START: String(runtimePort),
          ...(engineArch === "amd64" ? { CELLD_CONTAINER_PLATFORM: EXERCISED_PLATFORM } : {}),
        })
        /* The operator's grant, and the whole of it. */
        .withBindMounts([{ source: ENGINE_SOCKET, target: ENGINE_SOCKET, mode: "rw" }])
        .withUser(NODE_USER)
        .withCommand(["sail"])
        .withLogConsumer(collectLogs(engineLog))
        .withWaitStrategy(Wait.forLogMessage(/listening on/))
        .withStartupTimeout(BOOT_DEADLINE_MS),
      { log: engineLog, what: `node ${NODE_ENGINE}` },
    );
    engineHostPort = await forwarded(engineApiPort);
    observed.hostNetwork = {
      apiPort: engineApiPort,
      portRangeStart: runtimePort,
      gateway,
      reachedAt: engineHostPort,
      label: ENGINE_LABEL,
    };

    registry = registryAt(store.fromHost, BUCKET);

    const dir = await mkdtemp(join(tmpdir(), "scafo-e2e-containers-key-"));
    tmpDirs.push(dir);
    keyPath = join(dir, "operator.json");
    const keygen = await runCli(
      ["operator", "keygen", "--out", keyPath, "--register"],
      storeEnv(store.fromHost, BUCKET),
    );
    if (keygen.code !== 0) throw new Error(`"operator keygen" failed:\n${keygen.output}`);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    for (const forwarder of forwarders) await forwarder.stop().catch(() => {});
    await engine?.stop().catch(() => {});
    await plain?.stop().catch(() => {});
    await store?.container.stop().catch(() => {});
    /* The engine is the operator's own machine, and a real container start
       leaves its marks on it: what this suite put there, this suite takes
       away. */
    observed.cleanup = await cleanUpEngine();
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });

    console.log(`\n[e2e-containers] raw observations\n${JSON.stringify(observed, null, 2)}`);
  }, SETUP_TIMEOUT_MS);

  it(
    "deploys a container class to the selected node, starts it, and answers from inside it",
    async () => {
      /*
       * THE OPERATOR RECIPE, and the whole of it: the machines that have an
       * engine carry a label, and the application is created selecting it. The
       * selector is stated on the deploy that creates the application, so it is
       * in the record before anything is published and placement never had a
       * moment in which it could choose the other node.
       */
      const started = Date.now();
      const deploy = await deployTo(engineHostPort, APP_SERVED, await stageContainerApp(), [
        "--node-selector",
        ENGINE_LABEL,
      ]);
      observed.deployMs = Date.now() - started;
      expect(deploy.code, `${deploy.output}\n${tail(NODE_ENGINE, engineLog)}`).toBe(0);
      expect(deploy.output).toContain("deployed");

      const version = deploymentOf(deploy.output);
      expect(await listDeployments(registry, APP_SERVED)).toContain(version);

      /* The images the deployment names — the class's own, and the fence image
         that rides with it — read for what this suite must take off the engine
         again and for the platform check below, not judged: their shape is
         Celld's. */
      const manifest = await readManifest(version);
      fenceImage = manifest.fence_image;
      const references = [
        ...manifest.containers.map((entry) => entry.image),
        ...(manifest.fence_image === undefined ? [] : [manifest.fence_image]),
      ];
      builtImages.push(...references);

      /* Where an ingress would send this host, read off the node itself: ONE
         upstream, the labelled machine, which is the selector's whole job. */
      const host = `${APP_SERVED}.${PLATFORM_DOMAIN}`;
      const route = await until(`the routing document to name ${host}`, DEADLINE_MS, () =>
        routeFor(host),
      );
      expect(route.upstreams.map((upstream) => upstream.node)).toEqual([NODE_ENGINE]);
      const port = Number(route.upstreams[0]?.address.split(":").pop());
      expect(port, "the upstream named no port").toBeGreaterThan(0);
      const upstream = await forwarded(port);

      let served: HttpAnswer | null = null;
      const answer = await until(
        `${host} to serve "v1"`,
        DEADLINE_MS,
        async () => {
          served = await httpGet(upstream, "/", { host });
          return served.status === 200 && served.body.includes(`"v1"`) ? served : null;
        },
        {
          context: () => `last answer: ${JSON.stringify(served)}\n${tail(NODE_ENGINE, engineLog)}`,
        },
      );

      /*
       * THE CLASS ITSELF, which is the whole point: the object starts its
       * container through `ctx.container` and answers with what the container
       * served. Until here nothing had run — a deployment that only reaches the
       * bucket says nothing about whether this node can start a container.
       */
      let last: HttpAnswer | null = null;
      const startedContainer = Date.now();
      const fromContainer = await until(
        `${host}/sidecar to answer with what the container served`,
        CONTAINER_DEADLINE_MS,
        async () => {
          last = await httpGet(upstream, "/sidecar", { host });
          return last.status === 200 ? last : null;
        },
        { context: () => `last answer: ${JSON.stringify(last)}\n${tail(NODE_ENGINE, engineLog)}` },
      );
      const startMs = Date.now() - startedContainer;
      expect(fromContainer.body, "busybox's own httpd answered this, not the Worker").toContain(
        `"ok"`,
      );

      /* The image the class runs was built for the platform the daemon was
         given, which only the publish reads: the knob crossed to it. On any
         other engine host nothing was asked of the publish, and nothing is
         read back. */
      const classImage = manifest.containers.find(
        (entry) => entry.class_name === CONTAINER_CLASS,
      )?.image;
      expect(classImage, `the manifest names no image for ${CONTAINER_CLASS}`).toBeDefined();
      const exercised = engineArch === "amd64";
      const wanted = exercised ? EXERCISED_PLATFORM : `not exercised (${engineArch})`;
      const platform = exercised ? await imagePlatform(classImage as string) : wanted;
      observed.platform = platform;
      expect(platform).toBe(wanted);

      /* And the engine says so too: one running container of this class, naming
         the Celld node of this application's fleet that runs on the labelled
         machine — which is that machine's own node id, the name scafo gives
         Celld. */
      const running = await docker([
        "ps",
        "--filter",
        `label=celld.class=${CONTAINER_CLASS}`,
        "--format",
        '{{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Label "celld.node"}}\t{{.Names}}',
      ]);
      expect(running.code, running.output).toBe(0);
      const rows = running.output.trim().split("\n").filter(Boolean);
      expect(rows, `no running container is labelled celld.class=${CONTAINER_CLASS}`).toHaveLength(
        1,
      );
      const row = rows[0] as string;
      celldNode = row.split("\t")[3];
      expect(celldNode).toBe(NODE_ENGINE);
      expect(await celldNodesOfFleet()).toContain(celldNode);

      observed.deployed = {
        version,
        images: references,
        route,
        body: answer.body,
        container: {
          celldNode,
          startMs,
          body: fromContainer.body,
          ps: row,
          /* The node's own account of the one thing it had to do to the HOST
             before any container could start. */
          fenced: /[^\n]*container_bridges_fenced[^\n]*/.exec(engineLog.join(""))?.[0],
        },
      };
    },
    DEPLOY_STEP_TIMEOUT_MS,
  );

  it(
    "fails the deploy in Celld's own words when the node it went to has no engine",
    async () => {
      const started = Date.now();
      const deploy = await deployTo(plainApiPort, APP_NO_ENGINE, await stageContainerApp());
      const failedMs = Date.now() - started;
      expect(deploy.code, deploy.output).not.toBe(0);

      const record = await getDeployRecord(registry, APP_NO_ENGINE, deployIdOf(deploy.output));
      expect(record.state, tail(NODE_PLAIN, plainLog)).toBe("failed");
      expect(record.node).toBe(NODE_PLAIN);
      /* Scafo adds nothing of its own here: the publish it ran failed, which is
         `publish-failed` whatever the cause, and what is kept is the tail of
         what Celld said. Its wording is Celld's; all that is asserted of it is
         that it names the client the daemon was given, and not `docker`, which
         is what says `CELLD_DOCKER` reached the publish. */
      expect(record.code).toBe("publish-failed");
      expect(record.detail).toContain(ENGINE_CLI_ELSEWHERE);

      /* Nothing was published: no deployment of this application came of it,
         and nothing at all sits under its deploy prefix. */
      expect(record.deployment).toBeUndefined();
      expect(await listDeployments(registry, APP_NO_ENGINE)).toEqual([]);
      expect(await registry.store.list(deployPrefix(APP_NO_ENGINE))).toEqual([]);

      observed.noEngine = {
        failedMs,
        cli: deploy.output.trim(),
        record: { state: record.state, code: record.code, detail: record.detail },
      };
    },
    DEPLOY_STEP_TIMEOUT_MS,
  );
});

/* ---------------------------------------------------------------- internals */

/** What Celld's manifest says about a deployment's images. */
interface CelldManifest {
  containers: { class_name: string; image: string }[];
  fence_image?: string;
}

/** What every node container is configured with; the topology adds the rest. */
function nodeEnvironment(id: string, endpoint: string): Record<string, string> {
  return {
    ...storeEnv(endpoint, BUCKET),
    SCAFO_NODE_ID: id,
    SCAFO_TRANSPORT: "none",
    SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
  };
}

/** Publishes one port of the engine host's namespace; see {@link PROXY_SCRIPT}. */
async function forwarded(port: number): Promise<number> {
  const container = await new GenericContainer(IMAGE_REF)
    .withEntrypoint(["node"])
    .withCommand(["-e", PROXY_SCRIPT])
    .withEnvironment({ TARGET: `${gateway}:${String(port)}` })
    .withExposedPorts(port)
    /* Named, because the image declares a healthcheck of the daemon it usually
       runs and this container is not running that. */
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(BOOT_DEADLINE_MS)
    .start();
  forwarders.push(container);
  return container.getMappedPort(port);
}

/** A port nothing holds right now, for a container that publishes none. */
function freePort(): Promise<number> {
  return new Promise<number>((settle, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port === 0 ? fail(new Error("no free port")) : settle(port)));
    });
  });
}

/** A copy of the container-class fixture, staged as an operator's directory. */
async function stageContainerApp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scafo-e2e-containers-app-"));
  tmpDirs.push(dir);
  await cp(join(FIXTURES, "container-app"), dir, { recursive: true });
  return dir;
}

/** One deploy, run the way an operator runs it, against the node on `port`. */
function deployTo(
  port: number,
  application: string,
  dir: string,
  extra: string[] = [],
): Promise<CommandResult> {
  return runCli(
    [
      "deploy",
      dir,
      "--node",
      `http://127.0.0.1:${String(port)}`,
      "--name",
      application,
      "--key",
      keyPath,
      ...extra,
    ],
    {},
  );
}

/** The deploy id the CLI printed, which is how its record is read back. */
function deployIdOf(output: string): string {
  const id = /scafo: deploy (\S+)/.exec(output)?.[1];
  if (id === undefined) throw new Error(`the deploy named no id:\n${output}`);
  return id;
}

/**
 * The route for `host` as the node's own document renders it, or null while
 * nothing answers for it. WHAT AN INGRESS WOULD READ: the only place a runtime
 * process's port is written down, and the only place the selector shows.
 */
async function routeFor(host: string): Promise<FleetRouting["routes"][number] | null> {
  const answer = await httpGet(engineHostPort, "/v1/ingress/routes", {
    authorization: `Bearer ${INGRESS_TOKEN}`,
  });
  observed.routing = answer.body;
  if (answer.status !== 200) return null;
  const routing = JSON.parse(answer.body) as FleetRouting;
  return routing.routes.find((route) => route.host === host) ?? null;
}

/** The Celld nodes of the served application's fleet, by the id their containers carry. */
async function celldNodesOfFleet(): Promise<string[]> {
  const prefix = `${fleetPrefix(APP_SERVED)}/nodes/`;
  return (await registry.store.list(prefix)).map((key) =>
    key.slice(prefix.length).replace(/\.json$/, ""),
  );
}

/** Which of Celld's bridges the engine already holds. */
async function celldNetworksPresent(): Promise<string[]> {
  const listed = await docker(["network", "ls", "--format", "{{.Name}}"]);
  const names = listed.output.split("\n").map((line) => line.trim());
  return CELLD_NETWORKS.filter((name) => names.includes(name));
}

/**
 * Undoes what a real container start left on the operator's engine, and NOTHING
 * ELSE.
 *
 * Containers are found by the Celld node label, so only the ones this run's node
 * started are removed. The two bridges and the nftables table are taken down
 * only when the bridges were not already here when the suite began: they are
 * named the same for every Celld on a machine, and a table this suite did not
 * install is not this suite's to delete. The table goes through the same
 * privileged one-shot the fence image is meant for.
 */
async function cleanUpEngine(): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { keptNetworks };

  /* By the node when the run got far enough to read it, and by the class this
     suite's own fixture declares when it did not: either way the filter names
     something this suite put on the engine. */
  const mine =
    celldNode === undefined
      ? ["--filter", `label=celld.class=${CONTAINER_CLASS}`]
      : ["--filter", `label=celld.node=${celldNode}`];
  const listed = await docker(["ps", "-aq", ...mine]);
  const ids = listed.output.trim().split("\n").filter(Boolean);
  if (ids.length > 0) await docker(["rm", "-f", ...ids]);
  report.containersRemoved = ids;

  const ours = CELLD_NETWORKS.filter((name) => !keptNetworks.includes(name));
  if (ours.length > 0) {
    if (fenceImage !== undefined) {
      /* The fence image carries `nft` and nothing else, which is exactly the
         tool needed to take the fence back off the host. */
      const undone = await docker([
        "run",
        "--rm",
        "--network",
        "host",
        "--cap-add",
        "NET_ADMIN",
        fenceImage,
        "nft",
        "delete",
        "table",
        FENCE_TABLE,
      ]);
      report.fenceRemoved = undone.code === 0 ? FENCE_TABLE : undone.output.trim();
    }
    const removed = await docker(["network", "rm", ...ours]);
    report.networksRemoved = removed.code === 0 ? ours : removed.output.trim();
  }

  for (const image of builtImages) await docker(["image", "rm", "-f", image]).catch(() => {});
  report.imagesRemoved = builtImages;
  return report;
}

/** Celld's manifest for one deployment of the served application. */
async function readManifest(version: string): Promise<CelldManifest> {
  const prefix = deployPrefix(APP_SERVED);
  const key = (await registry.store.list(prefix)).find(
    (candidate) => candidate.endsWith("/manifest.json") && candidate.includes(`/${version}/`),
  );
  if (key === undefined) throw new Error(`no manifest was published for "${version}"`);
  const object = await registry.store.get(key);
  if (object === null) throw new Error(`manifest "${key}" disappeared`);
  return JSON.parse(object.body) as CelldManifest;
}

/** The `os/architecture` the engine holds `image` for, or what it said instead. */
async function imagePlatform(image: string): Promise<string> {
  const inspected = await docker([
    "image",
    "inspect",
    image,
    "--format",
    "{{.Os}}/{{.Architecture}}",
  ]);
  return inspected.code === 0 ? inspected.output.trim() : inspected.output;
}

/** One engine command, run the way an operator runs it. */
function docker(args: string[]): Promise<CommandResult> {
  return run("docker", args, REPO_ROOT, process.env as Record<string, string>);
}

/** The tail of a node container's output, as a failure message carries it. */
function tail(id: string, lines: string[]): string {
  const text = lines.join("");
  const shown = text.length <= 12_000 ? text : `…${text.slice(-12_000)}`;
  return `--- ${id} logs ---\n${shown}\n--- end ${id} logs ---`;
}
