/*
 * The Kubernetes contract: the operator manifest, K3s's default Traefik reading the fleet's
 * routing through the example's HelmChartConfig, and a locally built node image meet in one
 * disposable cluster. The routers move to the `web` entryPoint here — nothing in this cluster
 * can obtain a certificate, and product-specific TLS behaviour stays in its focused Docker suite.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as k8s from "@kubernetes/client-node";
import { K3sContainer, type StartedK3sContainer } from "@testcontainers/k3s";
import { GenericContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DaemonState } from "../../src/daemon/app.ts";
import type { OperatorKeyFile } from "../../src/cli/_operator-key.ts";
import { signNodeToken } from "../../src/core/auth/node-token.ts";
import { nodeKey, readJson, type RegistryContext } from "../../src/core/registry/index.ts";
import type { NodeRecord } from "../../src/core/types/registry.ts";
import type { ProcessStatus } from "../../src/core/types/supervisor.ts";
import {
  createBucket,
  deploymentOf,
  describeFailure,
  httpGet,
  registryAt,
  REPO_ROOT,
  run,
  runCli,
  stageApp,
  STORE_IMAGE,
  storeEnv,
  type BucketSettings,
  type CommandResult,
  until,
} from "./_harness.ts";

const E2E = process.env.SCAFO_K3S_E2E === "1";
const K3S_IMAGE = "rancher/k3s:v1.36.3-k3s1";
const IMAGE_TAG = "scafo-e2e-k3s";

/*
 * An image reference already in the local daemon, which this suite then saves
 * into the cluster instead of building the Dockerfile itself.
 *
 * CI builds the node image once at the start of the run, loads that one archive
 * into each job's daemon and names it here, so the cluster runs the bits the run
 * publishes rather than a rebuild of the same source. Unset, which is every
 * local run, the suite builds, as it always has.
 */
const PREBUILT_IMAGE: string = process.env.SCAFO_E2E_IMAGE ?? "";
/** What is saved into the cluster, and what the manifest's containers name. */
const IMAGE_REF: string = PREBUILT_IMAGE === "" ? IMAGE_TAG : PREBUILT_IMAGE;
const NAMESPACE = "scafo-e2e";
const PLATFORM_DOMAIN = "scafo.k3s.test";
/** What the cluster's Traefik presents to the fleet; both Secrets carry it. */
const INGRESS_TOKEN = "e2e-k3s-ingress-token";
/** The application the fixture's `wrangler.jsonc` names, placed on one node. */
const APPLICATION = "app";
const BUCKET: BucketSettings = {
  bucket: "scafo-k3s-e2e",
  prefix: "e2e",
  accessKey: "scafo",
  secretKey: "scafo-secret",
  region: "us-east-1",
};
const DEADLINE_MS = 180_000;
const CLI_TIMEOUT_MS = DEADLINE_MS;
/* Hook and scenario budgets total 28m, leaving CI time for install and reporting. */
const SETUP_TIMEOUT_MS = 600_000;
const SCENARIO_TIMEOUT_MS = 900_000;
const TEARDOWN_TIMEOUT_MS = 180_000;
const TRAEFIK_HTTP_PORT = 80;
/** Where the bundled Traefik polls the routing, once the manifest's Service is namespaced here. */
const PROVIDER_ENDPOINT = `http://scafo-api.${NAMESPACE}.svc:7400/v1/ingress/routes/traefik`;
const STORE_NODE_PORT = 30_333;
const API_NODE_PORT = 30_400;
const WGET_TIMEOUT_SECONDS = 10;
/** The suite's own Service, distinct from the manifest's `scafo-api`: one daemon, published. */
const CONTROL_SERVICE = "scafo-control-api";
const CONTROL_LABEL = "scafo.e2e/control";
const CONTROL_VALUE = "true";
const CONTROL_LABEL_PATH = CONTROL_LABEL.replaceAll("~", "~0").replaceAll("/", "~1");

interface Manifest {
  apiVersion?: string;
  kind?: string;
  metadata: { name?: string; namespace?: string };
  spec?: Record<string, unknown>;
  stringData?: Record<string, string>;
  data?: Record<string, string>;
}

let cluster: StartedK3sContainer;
let kubeConfig: k8s.KubeConfig;
let core: k8s.CoreV1Api;
let apps: k8s.AppsV1Api;
let objects: k8s.KubernetesObjectApi;
let storeEndpoint: string;
let apiPort: number;
let ingressPort: number;
let controlPodName: string;
let keyPath: string;
let operatorKey: OperatorKeyFile;
let registry: RegistryContext;
const tmpDirs: string[] = [];

/**
 * Everything the suite needs standing before its first case: the cluster, the
 * store, the manifest, the edge and one registered operator key.
 *
 * It is its own function so that a bring-up failure can be answered with the
 * logs of what it was talking to. Vitest has no failure hook for `beforeAll`,
 * and a suite that dies here reports only the step that raised — which, when
 * the store is what went wrong, names the CLI and never the bucket.
 */
async function bringUp(): Promise<void> {
  if (PREBUILT_IMAGE === "")
    await GenericContainer.fromDockerfile(REPO_ROOT, "Dockerfile")
      .withCache(true)
      .build(IMAGE_TAG, { deleteOnExit: false });

  const imageDir = await mkdtemp(join(tmpdir(), "scafo-k3s-image-"));
  tmpDirs.push(imageDir);
  const imageTar = join(imageDir, "scafo.tar");
  const saved = await run("docker", ["image", "save", "--output", imageTar, IMAGE_REF], REPO_ROOT, {
    PATH: process.env.PATH ?? "",
  });
  if (saved.code !== 0) throw new Error(`could not save the node image:\n${saved.output}`);

  /* The module disables Traefik unless this command is explicit. */
  cluster = await new K3sContainer(K3S_IMAGE)
    .withCommand(["server"])
    .withExposedPorts(TRAEFIK_HTTP_PORT, STORE_NODE_PORT, API_NODE_PORT)
    .withStartupTimeout(DEADLINE_MS)
    .start();
  await cluster.copyFilesToContainer([{ source: imageTar, target: "/tmp/scafo.tar" }]);
  const imported = await cluster.exec([
    "ctr",
    "--namespace",
    "k8s.io",
    "images",
    "import",
    "/tmp/scafo.tar",
  ]);
  if (imported.exitCode !== 0)
    throw new Error(`could not import the node image into K3s:\n${imported.output}`);

  kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromString(cluster.getKubeConfig());
  core = kubeConfig.makeApiClient(k8s.CoreV1Api);
  apps = kubeConfig.makeApiClient(k8s.AppsV1Api);
  objects = k8s.KubernetesObjectApi.makeApiClient(kubeConfig);

  await core.createNamespace({ body: { metadata: { name: NAMESPACE } } });
  await apply({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "seaweedfs", namespace: NAMESPACE },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: "seaweedfs" } },
      template: {
        metadata: { labels: { app: "seaweedfs" } },
        spec: {
          containers: [
            {
              name: "seaweedfs",
              image: STORE_IMAGE,
              args: ["server", "-s3"],
              ports: [{ containerPort: 8333 }],
            },
          ],
        },
      },
    },
  });
  await apply({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "seaweedfs", namespace: NAMESPACE },
    spec: {
      type: "NodePort",
      selector: { app: "seaweedfs" },
      ports: [{ port: 8333, targetPort: 8333, nodePort: STORE_NODE_PORT }],
    },
  });
  await apply({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "scafo-bucket", namespace: NAMESPACE },
    stringData: {
      SCAFO_S3_ACCESS_KEY: BUCKET.accessKey,
      SCAFO_S3_SECRET_KEY: BUCKET.secretKey,
    },
  });
  await apply({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "scafo-ingress", namespace: NAMESPACE },
    stringData: { SCAFO_INGRESS_TOKEN: INGRESS_TOKEN },
  });
  /* Traefik runs in kube-system and expands the token into its provider header
     from there, so the fleet's token needs a second copy in that namespace. */
  await apply({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "scafo-ingress", namespace: "kube-system" },
    stringData: { SCAFO_INGRESS_TOKEN: INGRESS_TOKEN },
  });
  await applyManifest();
  await applyTraefikConfig();

  await readyPod(NAMESPACE, "app=seaweedfs");
  storeEndpoint = `http://${cluster.getHost()}:${String(cluster.getMappedPort(STORE_NODE_PORT))}`;
  apiPort = cluster.getMappedPort(API_NODE_PORT);
  ingressPort = cluster.getMappedPort(TRAEFIK_HTTP_PORT);
  await createBucket(storeEndpoint, BUCKET.bucket);
  registry = registryAt(storeEndpoint, BUCKET);

  const keyDir = await mkdtemp(join(tmpdir(), "scafo-k3s-key-"));
  tmpDirs.push(keyDir);
  keyPath = join(keyDir, "operator.json");
  const keygen = await runK3sCli(
    ["operator", "keygen", "--out", keyPath, "--register"],
    storeEnv(storeEndpoint, BUCKET),
  );
  if (keygen.code !== 0) throw new Error(`could not register the operator key:\n${keygen.output}`);
  operatorKey = JSON.parse(await readFile(keyPath, "utf8")) as OperatorKeyFile;

  /* The helm-controller upgrades the bundled release when the HelmChartConfig
     lands, so readiness is the rolled-out pod carrying the provider argument,
     not merely an available one. */
  await until("K3s bundled Traefik to poll the fleet's routing", DEADLINE_MS, async () => {
    const deployment = await apps.readNamespacedDeployment({
      namespace: "kube-system",
      name: "traefik",
    });
    const args = deployment.spec?.template.spec?.containers[0]?.args ?? [];
    if (!args.some((argument) => argument.includes(PROVIDER_ENDPOINT))) return null;
    const status = deployment.status;
    return status?.availableReplicas === 1 &&
      status.updatedReplicas === 1 &&
      status.replicas === 1 &&
      status.observedGeneration === deployment.metadata?.generation
      ? deployment
      : null;
  });
  const control = (await nodes())[0];
  controlPodName = control.metadata?.name as string;
  await core.patchNamespacedPod({
    namespace: NAMESPACE,
    name: controlPodName,
    body: [
      {
        op: "add",
        path: `/metadata/labels/${CONTROL_LABEL_PATH}`,
        value: CONTROL_VALUE,
      },
    ],
  });
  await apply({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: CONTROL_SERVICE, namespace: NAMESPACE },
    spec: {
      type: "NodePort",
      selector: { [CONTROL_LABEL]: CONTROL_VALUE },
      ports: [{ port: 7400, targetPort: "api", nodePort: API_NODE_PORT }],
    },
  });
  await until("the test API service to pin one daemon", DEADLINE_MS, async () => {
    const [service, pods, endpoints] = await Promise.all([
      core.readNamespacedService({ namespace: NAMESPACE, name: CONTROL_SERVICE }),
      core.listNamespacedPod({
        namespace: NAMESPACE,
        labelSelector: "app.kubernetes.io/name=scafo",
      }),
      core.readNamespacedEndpoints({ namespace: NAMESPACE, name: CONTROL_SERVICE }),
    ]);
    const targets = pods.items
      .filter((pod) => pod.metadata?.labels?.[CONTROL_LABEL] === CONTROL_VALUE)
      .map((pod) => pod.metadata?.name);
    const endpointTargets = (endpoints.subsets ?? [])
      .flatMap((subset) => subset.addresses ?? [])
      .map((address) => address.targetRef?.name);
    if (
      Object.keys(service.spec?.selector ?? {}).length === 1 &&
      service.spec?.selector?.[CONTROL_LABEL] === CONTROL_VALUE &&
      targets.length === 1 &&
      targets[0] === controlPodName &&
      endpointTargets.length === 1 &&
      endpointTargets[0] === controlPodName
    )
      return true;
    return null;
  });

  const controlNode = (await stateOf(control)).node;
  if (controlNode === null) throw new Error("the control pod has not registered its node record");
  const controlNodeId = controlNode.id;
  await until("the pinned test API NodePort", DEADLINE_MS, async () => {
    const answer = await httpGet(apiPort, "/.well-known/scafo/health", {});
    if (answer.status !== 200) return null;
    const health = JSON.parse(answer.body) as { node?: string };
    return health.node === controlNodeId ? answer : null;
  });
  await until("the K3s Traefik platform apex", DEADLINE_MS, async () => {
    const answer = await httpGet(ingressPort, "/.well-known/scafo/health", {
      host: PLATFORM_DOMAIN,
    });
    return answer.status === 200 ? answer : null;
  });
}

describe.skipIf(!E2E)("the Kubernetes fleet contract", () => {
  beforeAll(async () => {
    try {
      await bringUp();
    } catch (error) {
      throw new Error(`${describeFailure(error)}\n${await setupLogs()}`, { cause: error });
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await cluster?.stop({ remove: true, removeVolumes: true }).catch(() => {});
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  }, TEARDOWN_TIMEOUT_MS);

  it(
    "deploys, proves placement, drains, and restarts through one control-plane lifecycle",
    async () => {
      const pods = await nodes();
      expect(pods).toHaveLength(2);
      for (const pod of pods) {
        expect(pod.status?.containerStatuses?.every((status) => status.ready)).toBe(true);
        const health = await podGet(pod, 7400, "/.well-known/scafo/health");
        expect(health.exitCode, health.output).toBe(0);
      }
      /* One replica, so the node that holds the application is the one the
         drain and the container kill below are aimed at. */
      const deploy = await runK3sCli(
        [
          "deploy",
          await stageApp("v1", tmpDirs),
          "--node",
          `http://127.0.0.1:${String(apiPort)}`,
          "--name",
          APPLICATION,
          "--replicas",
          "1",
          "--key",
          keyPath,
        ],
        {},
      );
      expect(deploy.code, deploy.output).toBe(0);
      expect(deploy.output).toContain("deployed");
      expect(deploymentOf(deploy.output)).toMatch(/^[\da-f]+$/);

      const placed = await settledSinglePlacement(APPLICATION);
      expect(placed.placement.nodes).toHaveLength(1);
      /* One node holds this host and the edge, which is colocated with neither,
         reaches it there: the routing it polls names the pod that runs it. */
      await assignedServes(APPLICATION, "v1");
      const leaving = placed.owner.pod;
      const leavingState = await stateOf(leaving);
      const leavingId = leavingState.node?.id;
      expect(leavingId).toBeDefined();
      const oldName = leaving.metadata?.name as string;
      const oldUid = leaving.metadata?.uid;
      await core.deleteNamespacedPod({ namespace: NAMESPACE, name: oldName });

      await until("the draining registry record", DEADLINE_MS, async () => {
        const record = await readJson<NodeRecord>(registry, nodeKey(leavingId as string));
        return record?.value.drainingAt === undefined ? null : record;
      });
      const replacement = await until("the StatefulSet replacement", DEADLINE_MS, async () => {
        const pods = await nodes();
        return pods.length === 2 && pods.every((pod) => pod.metadata?.uid !== oldUid) ? pods : null;
      });
      expect(replacement).toHaveLength(2);
      const restored = await until(
        "the replaced node to return with its retained identity",
        DEADLINE_MS,
        async () => {
          const record = await readJson<NodeRecord>(registry, nodeKey(leavingId as string));
          if (record === null || record.value.drainingAt !== undefined) return null;
          const pod = (await nodes()).find((candidate) => candidate.metadata?.name === oldName);
          if (pod === undefined) return null;
          const state = await stateOf(pod);
          return state.node?.id === leavingId ? state.node : null;
        },
      );
      expect(restored.id).toBe(leavingId);
      await assignedServes(APPLICATION, "v1");
      const victim = (await settledSinglePlacement(APPLICATION)).owner.pod;
      const name = victim.metadata?.name as string;
      const before =
        victim.status?.containerStatuses?.find((status) => status.name === "node")?.restartCount ??
        0;
      const sandbox = await crictlId(
        ["pods", "--namespace", NAMESPACE, "--name", name, "--state", "ready", "--quiet"],
        `pod sandbox for ${name}`,
      );
      const container = await crictlId(
        ["ps", "--pod", sandbox, "--name", "node", "--quiet"],
        `node container for ${name}`,
      );
      const stopped = await cluster.exec(["crictl", "stop", "--timeout", "0", container]);
      expect(stopped.exitCode, stopped.output).toBe(0);

      await until("the killed node container to restart", DEADLINE_MS, async () => {
        const pod = await core.readNamespacedPodStatus({ namespace: NAMESPACE, name });
        const restarted =
          pod.status?.containerStatuses?.find((status) => status.name === "node")?.restartCount ??
          0;
        return restarted > before &&
          pod.status?.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          )
          ? pod
          : null;
      });
      await assignedServes(APPLICATION, "v1");
    },
    SCENARIO_TIMEOUT_MS,
  );
});

async function apply(object: k8s.KubernetesObject & Record<string, unknown>): Promise<void> {
  await objects.create(object as k8s.KubernetesObject);
}

async function applyManifest(): Promise<void> {
  const raw = await readFile(join(REPO_ROOT, "examples/k3s/scafo.yaml"), "utf8");
  for (const object of k8s.loadAllYaml(raw) as Manifest[]) {
    object.metadata.namespace = NAMESPACE;
    // The disposable K3s cluster has no cert-manager CRDs or production issuer,
    // so neither the Certificate nor the Ingress that hands its Secret to
    // Traefik's certificate store has anything to carry here.
    if (object.kind === "Certificate" || object.kind === "Ingress") continue;
    if (
      object.kind === "ConfigMap" &&
      object.metadata.name === "scafo-node" &&
      object.data !== undefined
    ) {
      object.data.SCAFO_S3_ENDPOINT = "http://seaweedfs:8333";
      object.data.SCAFO_S3_BUCKET = BUCKET.bucket;
      object.data.SCAFO_S3_PREFIX = BUCKET.prefix;
      object.data.SCAFO_S3_REGION = BUCKET.region;
      object.data.SCAFO_PLATFORM_DOMAINS = PLATFORM_DOMAIN;
      // Nothing here can obtain a certificate: the routers move to plain HTTP.
      object.data.SCAFO_TRAEFIK_ENTRYPOINTS = "web";
    }
    if (object.kind === "StatefulSet" && object.metadata.name === "scafo-node") {
      const spec = object.spec as {
        replicas?: number;
        template: {
          spec: { containers: Array<{ name: string; image: string; imagePullPolicy?: string }> };
        };
      };
      const node = spec.template.spec.containers.find((container) => container.name === "node");
      if (node === undefined)
        throw new Error("the manifest's node StatefulSet has no node container");
      // The production example is one node; this scenario exercises its multi-node limit.
      spec.replicas = 2;
      node.image = IMAGE_REF;
      node.imagePullPolicy = "IfNotPresent";
    }
    await apply(object as unknown as k8s.KubernetesObject & Record<string, unknown>);
  }
}

/**
 * The example's HelmChartConfig, with this cluster's endpoint and without what
 * it cannot exercise: no `websecure` TLS, no ACME resolver, and no volume for
 * certificates that are never issued. What is left is the load-bearing half —
 * the http provider and the token expanded into its header.
 */
async function applyTraefikConfig(): Promise<void> {
  const raw = await readFile(join(REPO_ROOT, "examples/k3s/traefik-config.yaml"), "utf8");
  const config = k8s.loadYaml<Manifest & { spec: { valuesContent: string } }>(raw);
  const values = k8s.loadYaml<Record<string, unknown> & { additionalArguments: string[] }>(
    config.spec.valuesContent,
  );
  const trimmed = {
    additionalArguments: values.additionalArguments.map((argument) =>
      argument.replace("http://scafo-api.scafo.svc:7400", `http://scafo-api.${NAMESPACE}.svc:7400`),
    ),
    env: values.env,
  };
  if (!trimmed.additionalArguments.some((argument) => argument.includes(PROVIDER_ENDPOINT)))
    throw new Error(`the example's provider endpoint is not ${PROVIDER_ENDPOINT}`);
  await apply({
    apiVersion: config.apiVersion as string,
    kind: config.kind as string,
    metadata: { name: config.metadata.name, namespace: config.metadata.namespace },
    spec: { valuesContent: k8s.dumpYaml(trimmed) },
  });
}

async function nodes(): Promise<k8s.V1Pod[]> {
  return until("two ready scafo pods", DEADLINE_MS, async () => {
    const listed = await core.listNamespacedPod({
      namespace: NAMESPACE,
      labelSelector: "app.kubernetes.io/name=scafo",
    });
    const ready = listed.items.filter((pod) =>
      pod.status?.conditions?.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      ),
    );
    return ready.length === 2 ? ready : null;
  });
}

async function readyPod(namespace: string, labelSelector: string): Promise<k8s.V1Pod> {
  return until(`a ready pod matching ${labelSelector}`, DEADLINE_MS, async () => {
    const listed = await core.listNamespacedPod({ namespace, labelSelector });
    return (
      listed.items.find((pod) =>
        pod.status?.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        ),
      ) ?? null
    );
  });
}

async function stateOf(pod: k8s.V1Pod): Promise<DaemonState> {
  const answer = await podGet(pod, 7400, "/v1/state", {
    authorization: `Bearer ${await signNodeToken(operatorKey.privateKey, operatorKey.id)}`,
  });
  if (answer.exitCode !== 0) throw new Error(`/v1/state failed: ${answer.output}`);
  return JSON.parse(answer.output) as DaemonState;
}

async function serves(host: string, version: string): Promise<void> {
  let last = "nothing answered yet";
  await until(
    `${host} through K3s Traefik`,
    DEADLINE_MS,
    async () => {
      const answer = await httpGet(ingressPort, "/", { host });
      last = `last answer: ${String(answer.status)} ${answer.body.slice(0, 200)}`;
      return answer.status === 200 && answer.body.includes(`"${version}"`) ? answer : null;
    },
    /* Which side went quiet: the edge, or the pods whose routing it polls. */
    {
      context: async () => `${last}
${await edgeLogs()}`,
    },
  );
}

/**
 * What the node and Traefik containers logged last, and what each pod publishes
 * as the fleet's routing, so a host that never answers says which side went
 * quiet: the document, or the edge that reads it.
 */
async function edgeLogs(): Promise<string> {
  const logs = [await containerLogs(["node", "traefik", "seaweedfs"])];
  for (const pod of await nodes()) {
    const doc = await podGet(pod, 7400, "/v1/ingress/routes/traefik", {
      authorization: `Bearer ${INGRESS_TOKEN}`,
    });
    logs.push(`--- ${pod.metadata?.name ?? "pod"} ---\nrouting: ${doc.output.slice(0, 1500)}`);
  }
  return logs.join("\n");
}

/**
 * What the store and the nodes logged, for a bring-up that never reached a case.
 * A bring-up can die before the cluster exists, and before anything was ever
 * scheduled on it, so collecting nothing is an ordinary outcome here: whatever
 * goes wrong collecting logs must never replace the failure being reported.
 */
async function setupLogs(): Promise<string> {
  try {
    return await containerLogs(["seaweedfs", "node"]);
  } catch (error) {
    return `no logs could be collected: ${describeFailure(error)}`;
  }
}

/** The last lines every container by these names logged, live or exited. */
async function containerLogs(names: string[]): Promise<string> {
  const logs: string[] = [];
  for (const name of names) {
    const listed = await cluster.exec(["crictl", "ps", "-a", "--name", name, "--quiet"]);
    for (const id of listed.output.trim().split(/\s+/).filter(Boolean)) {
      const log = await cluster.exec(["crictl", "logs", "--tail", "60", id]);
      logs.push(`--- ${name} ${id.slice(0, 12)} ---\n${log.output}`);
    }
  }
  return logs.join("\n");
}

/** The host one application is served at under the platform domain. */
function hostOf(application: string): string {
  return `${application}.${PLATFORM_DOMAIN}`;
}

/** The placement settles on one node, and the shared edge answers wherever that is. */
async function assignedServes(application: string, version: string): Promise<void> {
  await settledSinglePlacement(application);
  await serves(hostOf(application), version);
}

async function settledSinglePlacement(application: string): Promise<{
  placement: { nodes: string[] };
  owner: { pod: k8s.V1Pod; state: DaemonState };
  nonOwner: { pod: k8s.V1Pod; state: DaemonState };
}> {
  /* What each node last claimed, so a timeout says which side never settled. */
  let seen = "nothing observed yet";
  return until(
    `a settled one-node placement for ${application}`,
    DEADLINE_MS,
    async () => {
      const states = await Promise.all(
        (await nodes()).map(async (pod) => ({ pod, state: await stateOf(pod) })),
      );
      seen = states
        .map(({ pod, state }) => {
          const placement = state.placements.find((view) => view.application === application);
          const processes = state.processes
            .map((process) => `${process.id}:${process.state}`)
            .join(",");
          return `${pod.metadata?.name ?? "pod"} (${state.node?.id ?? "no id"}): placement=${JSON.stringify(placement?.nodes ?? null)} processes=[${processes}]`;
        })
        .join("\n");
      const placements = states.map(({ state }) =>
        state.placements.find((view) => view.application === application),
      );
      const assignedNodeIds = placements[0]?.nodes;
      if (
        assignedNodeIds?.length !== 1 ||
        placements.some(
          (placement) =>
            placement === undefined ||
            placement.nodes.length !== 1 ||
            placement.nodes[0] !== assignedNodeIds[0],
        )
      )
        return null;
      const owner = states.find(({ state }) => state.node?.id === assignedNodeIds[0]);
      const nonOwner = states.find(({ state }) => state.node?.id !== assignedNodeIds[0]);
      /* Only a RUNNING process counts as serving. A node lists a process it
         stopped as exited for as long as it runs, so a node that held the
         application while its owner was away keeps an exited entry after the
         owner returns — bookkeeping, not a second runtime. */
      if (
        owner === undefined ||
        nonOwner === undefined ||
        !owner.state.processes.some((process) => runs(process, application)) ||
        nonOwner.state.processes.some((process) => runs(process, application))
      )
        return null;
      return { placement: { nodes: assignedNodeIds }, owner, nonOwner };
    },
    /* The store as well as the nodes: the placement a node publishes is a record
       it read out of the bucket, so a bucket that went quiet reads as a node
       that never settled. */
    { context: async () => `${seen}\n${await containerLogs(["node", "seaweedfs"])}` },
  );
}

async function podGet(
  pod: k8s.V1Pod,
  port: number,
  path: string,
  headers: Record<string, string> = {},
) {
  const address = pod.status?.podIP;
  if (address === undefined) throw new Error(`${pod.metadata?.name ?? "pod"} has no pod IP`);
  const args = [
    "/bin/wget",
    "-q",
    "-T",
    String(WGET_TIMEOUT_SECONDS),
    "-O",
    "-",
    ...Object.entries(headers).flatMap(([name, value]) => ["--header", `${name}: ${value}`]),
    `http://${address}:${String(port)}${path}`,
  ];
  return cluster.exec(args);
}

function runK3sCli(args: string[], extraEnv: Record<string, string>): Promise<CommandResult> {
  return runCli(args, extraEnv, { timeoutMs: CLI_TIMEOUT_MS });
}

/** Whether `process` is the running runtime of `application`. */
function runs(process: ProcessStatus, application: string): boolean {
  return process.state === "running" && process.id === application;
}

async function crictlId(args: string[], description: string): Promise<string> {
  const listed = await cluster.exec(["crictl", ...args]);
  expect(listed.exitCode, listed.output).toBe(0);
  const ids = listed.output.trim().split(/\s+/).filter(Boolean);
  expect(ids, `${description}: ${listed.output}`).toHaveLength(1);
  return ids[0] as string;
}
