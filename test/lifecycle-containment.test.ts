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

  it("keeps K3s Traefik at the edge and node-local Traefik beside each daemon", async () => {
    const documents = await manifestDocuments();
    const workload = documents.find(
      (document): document is KubernetesWorkload => document.kind === "StatefulSet",
    );
    const ingress = documents.find((document) => document.kind === "Ingress");
    const certificate = documents.find((document) => document.kind === "Certificate");

    expect(documents.some((document) => document.kind === "Secret")).toBe(false);
    expect(workload?.spec?.template?.spec?.containers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "node",
          image: "ghcr.io/sandros94/scafo:VERSION",
        }),
        expect.objectContaining({ name: "traefik", image: "traefik:v3.7.11" }),
      ]),
    );
    expect(ingress).toMatchObject({
      apiVersion: "networking.k8s.io/v1",
      spec: {
        ingressClassName: "traefik",
        rules: [
          {
            host: "apps.example.com",
            http: {
              paths: [
                {
                  backend: { service: { name: "scafo-ingress", port: { number: 80 } } },
                },
              ],
            },
          },
          {
            host: "*.apps.example.com",
            http: {
              paths: [
                {
                  backend: { service: { name: "scafo-ingress", port: { number: 80 } } },
                },
              ],
            },
          },
        ],
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
  spec?: Record<string, unknown>;
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
