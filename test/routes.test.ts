/* Routing exposes only an environment's current build. */

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
const BUILD = "aaaaaaaa";
const OLD = "bbbbbbbb";

describe("renderRoutes", () => {
  it("routes the environment label, project apex and custom domain to current", () => {
    const env = environment(APEX_ENVIRONMENT, BUILD, ["shop.example.com"]);
    const current = process(BUILD, true, 8100);
    const old = process(OLD, true, 8200);
    const desired = renderRoutes({
      platformDomains: ["apps.test"],
      environments: [{ project: PROJECT, env }],
      processes: [old, current],
      claims: [{ host: "shop.example.com", project: PROJECT, environment: env.name }],
    });

    expect(desired.routes).toEqual([
      { host: "shop--production.apps.test", backend: backend(current) },
      { host: "shop.apps.test", backend: backend(current) },
      { host: "shop.example.com", backend: backend(current) },
    ]);
    expect(desired.routes.some((route) => route.host.includes(OLD))).toBe(false);
  });

  it("does not route an unready current build or a ready superseded build", () => {
    const env = environment("preview", BUILD);
    expect(
      renderRoutes({
        platformDomains: ["apps.test"],
        environments: [{ project: PROJECT, env }],
        processes: [process(BUILD, false, 8100), process(OLD, true, 8200)],
        claims: [],
      }).routes,
    ).toEqual([]);
  });

  it("keeps environment names ahead of custom-domain collisions", () => {
    const first = environment("production", BUILD, ["shop--dev.apps.test"]);
    const second = environment("dev", OLD);
    const desired = renderRoutes({
      platformDomains: ["apps.test"],
      environments: [
        { project: PROJECT, env: first },
        { project: PROJECT, env: second },
      ],
      processes: [process(BUILD, true, 8100, "production"), process(OLD, true, 8200, "dev")],
      claims: [{ host: "shop--dev.apps.test", project: PROJECT, environment: "production" }],
    });
    expect(desired.routes.find((route) => route.host === "shop--dev.apps.test")?.backend.port).toBe(
      8200,
    );
  });

  it("publishes parked hosts and platform catch-alls to wake", () => {
    const env = environment("preview", BUILD, ["preview.example.com"]);
    const desired = renderRoutes({
      platformDomains: ["apps.test"],
      environments: [{ project: PROJECT, env }],
      processes: [],
      claims: [],
      wake: { port: 7331, parked: [{ project: PROJECT, env }] },
    });
    expect(desired.wake).toEqual({
      port: 7331,
      hosts: ["preview.example.com", "shop--preview.apps.test"],
      domains: ["apps.test"],
    });
  });

  it("publishes the API below explicit routes and above catch-alls", () => {
    const desired = renderRoutes({
      platformDomains: ["apps.test"],
      environments: [],
      processes: [],
      claims: [],
      wake: { port: 7331, parked: [] },
      api: { port: 7331 },
    });
    expect(desired.api).toEqual({ port: 7331, hosts: ["apps.test"], denied: API_DENIED_PREFIXES });
  });
});

describe("servingBackend", () => {
  it("selects only the ready process for current", () => {
    const env = environment("production", BUILD);
    expect(servingBackend(PROJECT, env, [process(OLD, true, 8200)])).toBeUndefined();
    expect(servingBackend(PROJECT, env, [process(BUILD, true, 8100)])?.port).toBe(8100);
  });
});

function environment(name: string, build: string, domains: string[] = []): EnvironmentRecord {
  return {
    v: 1,
    name,
    prefix: `fleets/${PROJECT}/${name}`,
    alias: { build, flippedAt: "2026-01-01T00:00:00.000Z" },
    domains,
    placement: "auto",
    ephemeral: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function process(build: string, ready: boolean, port: number, env = "production"): RuntimeProcess {
  return {
    processId: `${PROJECT}--${env}--${build}`,
    project: PROJECT,
    env,
    build,
    port,
    internalPort: port + 1,
    ready,
  };
}

function backend(process: RuntimeProcess): object {
  return { project: process.project, env: process.env, build: process.build, port: process.port };
}
