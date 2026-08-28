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
const KUBERNETES = join(REPO, "examples/kubernetes/node.yaml");
const dirs: string[] = [];
const run = promisify(execFile);

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("lifecycle containment artifacts", () => {
  it("renders a systemd unit that contains every remaining cgroup member", async () => {
    const directives = directivesOf(await renderedNodeUnit());

    expect(directives).toMatchObject({
      KillMode: "mixed",
      KillSignal: "SIGTERM",
      SendSIGKILL: "yes",
      TimeoutStopSec: "40s",
      Delegate: "no",
    });
  });

  it("keeps Kubernetes workloads in their own PID namespace with enough stop grace", async () => {
    const deployment = await deploymentManifest();
    const pod = deployment.spec?.template?.spec;

    expect(pod).toMatchObject({
      hostPID: false,
      shareProcessNamespace: false,
      terminationGracePeriodSeconds: expect.any(Number),
    });
    expect(pod?.terminationGracePeriodSeconds).toBeGreaterThanOrEqual(35);
  });

  it("uses the daemon health endpoint for startup, readiness and liveness", async () => {
    const deployment = await deploymentManifest();
    const node = deployment.spec?.template?.spec?.containers?.find(
      (container) => container.name === "node",
    );

    expect(node?.startupProbe).toMatchObject({
      httpGet: { path: "/v1/health", port: "api" },
    });
    expect(node?.readinessProbe).toMatchObject({
      httpGet: { path: "/v1/health", port: "api" },
      periodSeconds: 5,
    });
    expect(node?.livenessProbe).toMatchObject({
      httpGet: { path: "/v1/health", port: "api" },
      periodSeconds: 20,
      failureThreshold: 3,
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

/** The one Deployment in the multi-document Kubernetes manifest. */
async function deploymentManifest(): Promise<KubernetesDeployment> {
  const source = await readFile(KUBERNETES, "utf8");
  const documents = source
    .split(/^---\s*$/m)
    .filter((document) => document.trim() !== "")
    .map((document) => parseYAML<KubernetesDocument>(document))
    .filter((document): document is KubernetesDocument => document !== null);
  const deployment = documents.find((document) => document.kind === "Deployment");
  if (deployment === undefined) throw new Error("Kubernetes manifest has no Deployment");
  return deployment;
}

interface KubernetesDocument {
  kind?: string;
}

interface KubernetesDeployment extends KubernetesDocument {
  spec?: {
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
  startupProbe?: KubernetesHealthProbe;
  readinessProbe?: KubernetesHealthProbe;
  livenessProbe?: KubernetesHealthProbe;
}

interface KubernetesHealthProbe {
  httpGet?: {
    path?: string;
    port?: string | number;
  };
  periodSeconds?: number;
  failureThreshold?: number;
}
