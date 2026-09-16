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
  it("routes every host to the running environment process", () => {
    const env = environment(APEX_ENVIRONMENT, ["shop.example.com"]);
    const running = process(8100);
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

  it("routes independently of celld deployment revisions", () => {
    const running = process(8100);
    expect(servingBackend(PROJECT, environment("production"), [running])).toEqual(backend(running));
  });

  it("publishes the API independently of unrouted environments", () => {
    const env = environment("preview", ["preview.example.com"]);
    const desired = renderRoutes({
      platformDomains: ["apps.test"],
      environments: [{ project: PROJECT, env }],
      processes: [],
      claims: [],
      api: { port: 7331 },
    });
    expect(desired.routes).toEqual([]);
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
    ephemeral: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function process(port: number): RuntimeProcess {
  return {
    processId: `${PROJECT}--production`,
    project: PROJECT,
    env: "production",
    port,
    internalPort: port + 1,
  };
}

function backend(runtime: RuntimeProcess): object {
  return { project: runtime.project, env: runtime.env, port: runtime.port };
}
