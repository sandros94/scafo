import { describe, expect, it } from "vitest";
import {
  APEX_ENVIRONMENT,
  API_DENIED_PREFIXES,
  renderRoutes,
  servingBackend,
} from "../src/core/placement/routes.ts";
import type { EnvironmentRecord } from "../src/core/types/registry.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";

const PROJECT = "shop";

describe("environment routing", () => {
  it("routes every host to the ready environment process", () => {
    const env = environment(APEX_ENVIRONMENT, ["shop.example.com"]);
    const running = process(true, 8100);
    expect(
      renderRoutes({
        platformDomains: ["apps.test"],
        environments: [{ project: PROJECT, env }],
        processes: [running],
        claims: [{ host: "shop.example.com", project: PROJECT, environment: env.name }],
      }).routes,
    ).toEqual([
      { host: "shop--production.apps.test", backend: backend(running) },
      { host: "shop.apps.test", backend: backend(running) },
      { host: "shop.example.com", backend: backend(running) },
    ]);
  });

  it("keeps a ready old generation routed while newer adoption is pending or rejected", () => {
    const env = environment("production");
    const old = { ...process(true, 8100), attemptedRevision: 2, appliedRevision: 1 };
    expect(servingBackend(PROJECT, env, [old])).toEqual(backend(old));
  });

  it("does not route an unready process", () => {
    expect(
      servingBackend(PROJECT, environment("production"), [process(false, 8100)]),
    ).toBeUndefined();
  });

  it("publishes parked hosts and the API separately", () => {
    const env = environment("preview", ["preview.example.com"]);
    const desired = renderRoutes({
      platformDomains: ["apps.test"],
      environments: [{ project: PROJECT, env }],
      processes: [],
      claims: [],
      wake: { port: 7331, parked: [{ project: PROJECT, env }] },
      api: { port: 7331 },
    });
    expect(desired.wake).toEqual({
      port: 7331,
      hosts: ["preview.example.com", "shop--preview.apps.test"],
      domains: ["apps.test"],
    });
    expect(desired.api).toEqual({ port: 7331, hosts: ["apps.test"], denied: API_DENIED_PREFIXES });
  });
});

function environment(name: string, domains: string[] = []): EnvironmentRecord {
  return {
    v: 1,
    name,
    prefix: `fleets/${PROJECT}/${name}`,
    deployment: { revision: 2, deployedAt: "2026-01-01T00:00:00.000Z" },
    domains,
    placement: "auto",
    ephemeral: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function process(ready: boolean, port: number): RuntimeProcess {
  return {
    processId: `${PROJECT}--production`,
    project: PROJECT,
    env: "production",
    attemptedRevision: 2,
    appliedRevision: 2,
    deployment: { version: "version", prefix: "deployments/main/version", generation: 2 },
    port,
    internalPort: port + 1,
    ready,
  };
}

function backend(runtime: RuntimeProcess): object {
  return { project: runtime.project, env: runtime.env, port: runtime.port };
}
