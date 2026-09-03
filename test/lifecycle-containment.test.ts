/* The deployment artifacts that make abrupt daemon death bounded. */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseYAML } from "confbox/yaml";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = join(REPO, "scripts/install.sh");
const K3S = join(REPO, "examples/k3s/scafo.yaml");
const TRAEFIK_CONFIG = join(REPO, "examples/k3s/traefik-config.yaml");
const dirs: string[] = [];
const run = promisify(execFile);

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("lifecycle containment artifacts", () => {
  it("renders a systemd unit that contains every remaining cgroup member", async () => {
    const unit = await renderedNodeUnit();
    const directives = directivesOf(unit);

    expect(unit).toContain("\nEnvironment=CELLD_ESBUILD=/usr/local/bin/esbuild\n");
    expect(directives).toMatchObject({
      KillMode: "mixed",
      KillSignal: "SIGTERM",
      SendSIGKILL: "yes",
      TimeoutStopSec: "50s",
      Delegate: "no",
    });
  });

  it("keeps Kubernetes workloads in their own PID namespace with enough stop grace", async () => {
    const workload = await workloadManifest();
    const pod = workload.spec?.template?.spec;

    expect(pod).toMatchObject({
      hostPID: false,
      shareProcessNamespace: false,
      terminationGracePeriodSeconds: expect.any(Number),
    });
    expect(pod?.terminationGracePeriodSeconds).toBeGreaterThanOrEqual(50);
  });

  it("uses the daemon health endpoint for startup, readiness and liveness", async () => {
    const workload = await workloadManifest();
    const node = workload.spec?.template?.spec?.containers?.find(
      (container) => container.name === "node",
    );

    expect(node?.startupProbe).toMatchObject({
      httpGet: { path: "/.well-known/scafo/health", port: "api" },
    });
    expect(node?.readinessProbe).toMatchObject({
      httpGet: { path: "/.well-known/scafo/health", port: "api" },
      periodSeconds: 5,
    });
    expect(node?.livenessProbe).toMatchObject({
      httpGet: { path: "/.well-known/scafo/health", port: "api" },
      periodSeconds: 20,
      failureThreshold: 3,
    });
  });

  it("uses the documented starter resources without making CPU a hard limit", async () => {
    const workload = await workloadManifest();
    const node = workload.spec?.template?.spec?.containers?.find(
      (container) => container.name === "node",
    );

    expect(node?.resources).toEqual({
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { memory: "2Gi" },
    });
  });

  it("leaves the pods without an ingress and publishes the routing K3s Traefik polls", async () => {
    const documents = await manifestDocuments();
    const workload = documents.find(
      (document): document is KubernetesWorkload => document.kind === "StatefulSet",
    );
    const api = documents.find(
      (document) => document.kind === "Service" && document.metadata?.name === "scafo-api",
    );
    const certificate = documents.find((document) => document.kind === "Certificate");

    expect(documents.some((document) => document.kind === "Secret")).toBe(false);
    /* The cluster's Traefik routes the whole fleet, so a pod is one container. */
    expect(workload?.spec?.template?.spec?.containers).toEqual([
      expect.objectContaining({ name: "node", image: "ghcr.io/sandros94/scafo:VERSION" }),
    ]);
    expect(api).toMatchObject({
      spec: {
        type: "ClusterIP",
        selector: { "app.kubernetes.io/name": "scafo" },
        ports: [{ port: 7400, targetPort: "api" }],
      },
    });
    expect(workload).toMatchObject({
      spec: {
        replicas: 1,
        serviceName: "scafo-nodes",
        volumeClaimTemplates: [
          {
            metadata: { name: "state" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: { requests: { storage: "1Gi" } },
            },
          },
        ],
      },
    });
    expect(certificate).toMatchObject({
      apiVersion: "cert-manager.io/v1",
      spec: {
        issuerRef: { kind: "ClusterIssuer" },
        secretName: "scafo-platform-tls",
        dnsNames: ["apps.example.com", "*.apps.example.com"],
      },
    });
  });

  it("carries the platform certificate to Traefik's store without routing anything", async () => {
    const ingress = (await manifestDocuments()).find((document) => document.kind === "Ingress");

    /* Rules would be routes, and every route here comes from the http provider:
       Traefik's Kubernetes provider reads `spec.tls` before it reads rules, so
       this loads the Secret into the certificate store and nothing else. */
    expect(ingress).toMatchObject({
      apiVersion: "networking.k8s.io/v1",
      spec: {
        ingressClassName: "traefik",
        tls: [
          {
            hosts: ["apps.example.com", "*.apps.example.com"],
            secretName: "scafo-platform-tls",
          },
        ],
      },
    });
    expect(ingress?.spec?.rules).toBeUndefined();
  });

  it("points the bundled Traefik at the routing service on the entryPoint the nodes render", async () => {
    const documents = await manifestDocuments();
    const settings = documents.find(
      (document) => document.kind === "ConfigMap" && document.metadata?.name === "scafo-node",
    );
    const chart = parseYAML<KubernetesDocument>(await readFile(TRAEFIK_CONFIG, "utf8"));
    const values = parseYAML<TraefikValues>(
      (chart.spec as { valuesContent: string }).valuesContent,
    );
    const service = documents.find(
      (document) => document.kind === "Service" && document.metadata?.name === "scafo-api",
    );

    expect(chart).toMatchObject({
      apiVersion: "helm.cattle.io/v1",
      kind: "HelmChartConfig",
      metadata: { name: "traefik", namespace: "kube-system" },
    });
    expect(values.additionalArguments).toContain(
      `--providers.http.endpoint=http://${String(service?.metadata?.name)}.scafo.svc:7400/v1/ingress/routes/traefik`,
    );
    /* The token reaches the header through the container's environment, so it
       stays in the Secret rather than in the chart values. */
    expect(values.additionalArguments).toContain(
      "--providers.http.headers.Authorization=Bearer $(SCAFO_INGRESS_TOKEN)",
    );
    expect(values.env).toEqual([
      {
        name: "SCAFO_INGRESS_TOKEN",
        valueFrom: { secretKeyRef: { name: "scafo-ingress", key: "SCAFO_INGRESS_TOKEN" } },
      },
    ]);
    /* One entryPoint named in two files; were they to disagree, the routers
       would attach to an entryPoint the chart never opened. */
    expect(Object.keys(values.ports)).toEqual([settings?.data?.SCAFO_TRAEFIK_ENTRYPOINTS]);
    expect(values.ports.websecure?.http?.tls?.certResolver).toBe("letsencrypt");
    expect(values.certificatesResolvers.letsencrypt.acme.httpChallenge.entryPoint).toBe("web");
  });
});

/** Renders the installer's node unit without fetching or installing anything. */
async function renderedNodeUnit(): Promise<string> {
  const source = await readFile(INSTALL, "utf8");
  const rendered = source.replace(/\nmain "\$@"\s*$/, "\nrender_node_unit\n");
  if (rendered === source) throw new Error("install script no longer ends by calling main");

  const dir = await mkdtemp(join(tmpdir(), "scafo-unit-render-"));
  dirs.push(dir);
  const script = join(dir, "render-unit.sh");
  await writeFile(script, rendered, "utf8");

  return (await run("sh", [script], { env: { ...process.env, BIN_DIR: "/usr/local/bin" } })).stdout;
}

/** Directives of one rendered systemd unit, excluding comments and blank lines. */
function directivesOf(unit: string): Record<string, string> {
  const directives: Record<string, string> = {};
  for (const line of unit.split("\n")) {
    if (line.startsWith("#") || !line.includes("=")) continue;
    const [name, value] = line.split("=", 2);
    if (name === undefined || value === undefined) continue;
    directives[name] = value;
  }
  return directives;
}

/** The one StatefulSet in the multi-document K3s manifest. */
async function workloadManifest(): Promise<KubernetesWorkload> {
  const workload = (await manifestDocuments()).find(
    (document): document is KubernetesWorkload => document.kind === "StatefulSet",
  );
  if (workload === undefined) throw new Error("K3s manifest has no StatefulSet");
  return workload;
}

/** Documents in the production K3s manifest. */
async function manifestDocuments(): Promise<KubernetesDocument[]> {
  const source = await readFile(K3S, "utf8");
  return source
    .split(/^---\s*$/m)
    .filter((document) => document.trim() !== "")
    .map((document) => parseYAML<KubernetesDocument>(document))
    .filter((document): document is KubernetesDocument => document !== null);
}

interface KubernetesDocument {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string };
  data?: Record<string, string>;
  spec?: Record<string, unknown>;
}

/** The half of the bundled chart's values this example sets. */
interface TraefikValues {
  additionalArguments: string[];
  env: unknown[];
  ports: Record<string, { http?: { tls?: { certResolver?: string } } }>;
  certificatesResolvers: {
    letsencrypt: { acme: { httpChallenge: { entryPoint: string } } };
  };
}

interface KubernetesWorkload extends KubernetesDocument {
  spec?: {
    replicas?: number;
    serviceName?: string;
    volumeClaimTemplates?: KubernetesPersistentVolumeClaim[];
    template?: {
      spec?: {
        hostPID?: boolean;
        shareProcessNamespace?: boolean;
        terminationGracePeriodSeconds?: number;
        containers?: KubernetesContainer[];
      };
    };
  };
}

interface KubernetesContainer {
  name?: string;
  resources?: KubernetesResources;
  startupProbe?: KubernetesHealthProbe;
  readinessProbe?: KubernetesHealthProbe;
  livenessProbe?: KubernetesHealthProbe;
}

interface KubernetesPersistentVolumeClaim {
  metadata?: { name?: string };
  spec?: {
    accessModes?: string[];
    resources?: { requests?: Record<string, string> };
  };
}

interface KubernetesResources {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

interface KubernetesHealthProbe {
  httpGet?: {
    path?: string;
    port?: string | number;
  };
  periodSeconds?: number;
  failureThreshold?: number;
}
