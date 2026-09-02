/*
 * The Kubernetes contract: the operator manifest, K3s's default Traefik, and a locally built node
 * image meet in one disposable cluster. Product-specific TLS behaviour stays in its focused
 * Docker suite.
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
import {
  nodeKey,
  placementKey,
  readJson,
  type RegistryContext,
} from "../../src/core/registry/index.ts";
import type { NodeRecord, PlacementRecord } from "../../src/core/types/registry.ts";
import type { ProcessStatus } from "../../src/core/types/supervisor.ts";
import {
  buildIdOf,
  buildRepo,
  type BucketSettings,
  type CommandResult,
  createBucket,
  httpGet,
  registryAt,
  REPO_ROOT,
  run,
  runCli,
  stageApp,
  storeEnv,
  until,
} from "./_harness.ts";

const E2E = process.env.SCAFO_K3S_E2E === "1";
const K3S_IMAGE = "rancher/k3s:v1.36.3-k3s1";
const IMAGE_TAG = "scafo-e2e-k3s";
const NAMESPACE = "scafo-e2e";
const PLATFORM_DOMAIN = "scafo.k3s.test";
const PROJECT = "app";
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
const STORE_NODE_PORT = 30_333;
const API_NODE_PORT = 30_400;
const WGET_TIMEOUT_SECONDS = 10;
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

describe.skipIf(!E2E)("the Kubernetes fleet contract", () => {
  beforeAll(async () => {
    await buildRepo();
    await GenericContainer.fromDockerfile(REPO_ROOT, "Dockerfile")
      .withCache(true)
      .build(IMAGE_TAG, { deleteOnExit: false });

    const imageDir = await mkdtemp(join(tmpdir(), "scafo-k3s-image-"));
    tmpDirs.push(imageDir);
    const imageTar = join(imageDir, "scafo.tar");
    const saved = await run(
      "docker",
      ["image", "save", "--output", imageTar, IMAGE_TAG],
      REPO_ROOT,
      {
        PATH: process.env.PATH ?? "",
      },
    );
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
                image: "chrislusf/seaweedfs:4.42",
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
    await applyManifest();
    await apply({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: { name: "scafo", namespace: NAMESPACE },
      spec: {
        ingressClassName: "traefik",
        rules: [
          {
            host: `*.${PLATFORM_DOMAIN}`,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: { service: { name: "scafo-ingress", port: { number: 80 } } },
                },
              ],
            },
          },
        ],
      },
    });

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
    if (keygen.code !== 0)
      throw new Error(`could not register the operator key:\n${keygen.output}`);
    operatorKey = JSON.parse(await readFile(keyPath, "utf8")) as OperatorKeyFile;

    await until("K3s bundled Traefik", DEADLINE_MS, async () => {
      const deployment = await apps.readNamespacedDeploymentStatus({
        namespace: "kube-system",
        name: "traefik",
      });
      return deployment.status?.availableReplicas === 1 ? deployment : null;
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
      metadata: { name: "scafo-api", namespace: NAMESPACE },
      spec: {
        type: "NodePort",
        selector: { [CONTROL_LABEL]: CONTROL_VALUE },
        ports: [{ port: 7400, targetPort: "api", nodePort: API_NODE_PORT }],
      },
    });
    await until("the test API service to pin one daemon", DEADLINE_MS, async () => {
      const [service, pods, endpoints] = await Promise.all([
        core.readNamespacedService({ namespace: NAMESPACE, name: "scafo-api" }),
        core.listNamespacedPod({
          namespace: NAMESPACE,
          labelSelector: "app.kubernetes.io/name=scafo",
        }),
        core.readNamespacedEndpoints({ namespace: NAMESPACE, name: "scafo-api" }),
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
      const deploy = await runK3sCli(
        [
          "deploy",
          await stageApp("v1", tmpDirs),
          "--node",
          `http://127.0.0.1:${String(apiPort)}`,
          "--project",
          PROJECT,
          "--env",
          "production",
          "--replicas",
          "all",
          "--key",
          keyPath,
        ],
        {},
      );
      expect(deploy.code, deploy.output).toBe(0);
      expect(deploy.output).toContain("deployed");
      expect(buildIdOf(deploy.output)).toMatch(/^[\da-f]+$/);
      await serves(`${PROJECT}.${PLATFORM_DOMAIN}`, "v1");

      const production = await until(
        "the all-replica placement and one process on each node",
        DEADLINE_MS,
        async () => {
          const placement = await readJson<PlacementRecord>(
            registry,
            placementKey(PROJECT, "production"),
          );
          if (placement?.value.nodes.length !== 2) return null;
          const states = await Promise.all((await nodes()).map(stateOf));
          const nodeIds: string[] = [];
          for (const state of states) {
            if (state.node === null) return null;
            nodeIds.push(state.node.id);
          }
          if (
            new Set(nodeIds).size !== 2 ||
            !placement.value.nodes.every((id) => nodeIds.includes(id)) ||
            !states.every((state) => state.processes.filter(runsProduction).length === 1)
          )
            return null;
          return { placement: placement.value, nodeIds, states };
        },
      );
      expect(
        [...production.placement.nodes].sort((left, right) => left.localeCompare(right)),
      ).toEqual([...production.nodeIds].sort((left, right) => left.localeCompare(right)));
      for (const state of production.states) {
        expect(state.processes.filter(runsProduction)).toHaveLength(1);
      }

      const retired = await runK3sCli(
        [
          "env",
          "retire",
          "--project",
          PROJECT,
          "--env",
          "production",
          "--node",
          `http://127.0.0.1:${String(apiPort)}`,
          "--key",
          keyPath,
        ],
        {},
      );
      expect(retired.code, retired.output).toBe(0);
      await until("the all-replica proof to release both runtimes", DEADLINE_MS, async () => {
        const states = await Promise.all((await nodes()).map(stateOf));
        return states.every((state) => !state.processes.some(runsProduction)) ? states : null;
      });

      const single = await runK3sCli(
        [
          "deploy",
          await stageApp("v1", tmpDirs),
          "--node",
          `http://127.0.0.1:${String(apiPort)}`,
          "--project",
          PROJECT,
          "--env",
          "single",
          "--replicas",
          "1",
          "--key",
          keyPath,
        ],
        {},
      );
      expect(single.code, single.output).toBe(0);
      expect(single.output).toContain("deployed");

      const placed = await settledSinglePlacement("single");
      expect(placed.placement.nodes).toHaveLength(1);
      const { owner, nonOwner } = placed;
      await assignedServes("single", "v1");
      const owned = await podGet(owner.pod, 8000, "/", {
        host: `${PROJECT}--single.${PLATFORM_DOMAIN}`,
      });
      expect(owned.exitCode, owned.output).toBe(0);
      expect(owned.output).toContain('"v1"');
      const unmatched = await podGet(nonOwner.pod, 8000, "/", {
        host: `${PROJECT}--single.${PLATFORM_DOMAIN}`,
      });
      expect(unmatched.exitCode, unmatched.output).not.toBe(0);
      expect(unmatched.output).toContain("404");
      const leaving = owner.pod;
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
      const replacement = await until("the Deployment replacement", DEADLINE_MS, async () => {
        const pods = await nodes();
        return pods.length === 2 && pods.every((pod) => pod.metadata?.uid !== oldUid) ? pods : null;
      });
      expect(replacement).toHaveLength(2);
      await assignedServes("single", "v1");
      const victim = (await settledSinglePlacement("single")).owner.pod;
      const name = victim.metadata?.name as string;
      const before =
        victim.status?.containerStatuses?.find((status) => status.name === "node")?.restartCount ??
        0;
      const sandbox = await crictlId(
        ["pods", "--namespace", NAMESPACE, "--name", name, "--quiet"],
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
      await assignedServes("single", "v1");
    },
    SCENARIO_TIMEOUT_MS,
  );
});

async function apply(object: k8s.KubernetesObject & Record<string, unknown>): Promise<void> {
  await objects.create(object as k8s.KubernetesObject);
}

async function applyManifest(): Promise<void> {
  const raw = await readFile(join(REPO_ROOT, "examples/kubernetes/node.yaml"), "utf8");
  for (const object of k8s.loadAllYaml(raw) as Manifest[]) {
    object.metadata.namespace = NAMESPACE;
    if (object.kind === "Secret" && object.metadata.name === "scafo-bucket") {
      object.stringData = {
        SCAFO_S3_ACCESS_KEY: BUCKET.accessKey,
        SCAFO_S3_SECRET_KEY: BUCKET.secretKey,
      };
    }
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
    }
    if (object.kind === "Deployment" && object.metadata.name === "scafo-node") {
      const spec = object.spec as {
        template: {
          spec: { containers: Array<{ name: string; image: string; imagePullPolicy?: string }> };
        };
      };
      const node = spec.template.spec.containers.find((container) => container.name === "node");
      if (node === undefined)
        throw new Error("the manifest's node Deployment has no node container");
      node.image = IMAGE_TAG;
      node.imagePullPolicy = "IfNotPresent";
    }
    if (
      object.kind === "Service" &&
      object.metadata.name === "scafo-ingress" &&
      object.spec !== undefined
    )
      object.spec.type = "ClusterIP";
    await apply(object as unknown as k8s.KubernetesObject & Record<string, unknown>);
  }
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
  await until(`${host} through K3s Traefik`, DEADLINE_MS, async () => {
    const answer = await httpGet(ingressPort, "/", { host });
    return answer.status === 200 && answer.body.includes(`"${version}"`) ? answer : null;
  });
}

async function assignedServes(env: string, version: string): Promise<void> {
  const { owner } = await settledSinglePlacement(env);
  await until(`${env}'s assigned node to serve through its sidecar`, DEADLINE_MS, async () => {
    const answer = await podGet(owner.pod, 8000, "/", {
      host: `${PROJECT}--${env}.${PLATFORM_DOMAIN}`,
    });
    return answer.exitCode === 0 && answer.output.includes(`"${version}"`) ? answer : null;
  });
}

async function settledSinglePlacement(env: string): Promise<{
  placement: PlacementRecord;
  owner: { pod: k8s.V1Pod; state: DaemonState };
  nonOwner: { pod: k8s.V1Pod; state: DaemonState };
}> {
  return until(`a settled one-node placement for ${env}`, DEADLINE_MS, async () => {
    const placement = await readJson<PlacementRecord>(registry, placementKey(PROJECT, env));
    if (placement?.value.nodes.length !== 1) return null;
    const states = await Promise.all(
      (await nodes()).map(async (pod) => ({ pod, state: await stateOf(pod) })),
    );
    const owner = states.find(({ state }) => state.node?.id === placement.value.nodes[0]);
    const nonOwner = states.find(({ state }) => state.node?.id !== placement.value.nodes[0]);
    const processId = `${PROJECT}--${env}`;
    if (
      owner === undefined ||
      nonOwner === undefined ||
      !owner.state.processes.some((process) => process.id === processId) ||
      nonOwner.state.processes.some((process) => process.id === processId)
    )
      return null;
    return { placement: placement.value, owner, nonOwner };
  });
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

function runsProduction(process: ProcessStatus): boolean {
  return process.state === "running" && process.id === `${PROJECT}--production`;
}

async function crictlId(args: string[], description: string): Promise<string> {
  const listed = await cluster.exec(["crictl", ...args]);
  expect(listed.exitCode, listed.output).toBe(0);
  const ids = listed.output.trim().split(/\s+/).filter(Boolean);
  expect(ids, `${description}: ${listed.output}`).toHaveLength(1);
  return ids[0] as string;
}
