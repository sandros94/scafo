/*
 * renderRoutes: which hosts a node answers on, given what it actually has
 * running. Pure throughout — no registry, no ingress, no processes.
 */

import { describe, expect, it } from "vitest";
import {
  APEX_ENVIRONMENT,
  renderRoutes,
  type RenderRoutesInput,
  type RouteClaim,
} from "../src/core/placement/routes.ts";
import type { EnvironmentRecord } from "../src/core/types/registry.ts";
import type { IngressDesired } from "../src/core/types/ingress.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";
import { SLUG_MAX_LENGTH } from "../src/core/utils/slug.ts";

const DOMAIN = "apps.test";
const OTHER_DOMAIN = "apps.example";
const PROJECT = "shop";
const BUILD = "aaaa1111";
const OLDER = "bbbb2222";

describe("only what is ready is routed", () => {
  it("emits nothing for a process that has not passed its gate", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)],
        processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, false)],
      }),
    );

    expect(desired.routes).toEqual([]);
  });

  it("emits nothing for an environment whose alias was never flipped", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, "preview")],
        processes: [process(PROJECT, "preview", BUILD, 42_000, true)],
      }),
    );

    /* No alias means no environment host — but the build a running process
       serves is still reachable under its own hash. */
    expect(hosts(desired)).toEqual([`${PROJECT}--${BUILD}.${DOMAIN}`]);
  });
});

describe("the hosts an environment answers on", () => {
  it("gives production its own label and the project's apex", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)],
        processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true)],
      }),
    );

    /* Sorted by code unit, which puts "-" ahead of "." and so the labelled
       hosts ahead of the apex. */
    expect(hosts(desired)).toEqual([
      `${PROJECT}--${BUILD}.${DOMAIN}`,
      `${PROJECT}--${APEX_ENVIRONMENT}.${DOMAIN}`,
      `${PROJECT}.${DOMAIN}`,
    ]);
    for (const route of desired.routes) {
      expect(route.backend).toEqual({
        project: PROJECT,
        env: APEX_ENVIRONMENT,
        build: BUILD,
        port: 42_000,
      });
    }
  });

  it("gives every other environment its label and no apex", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, "staging", BUILD)],
        processes: [process(PROJECT, "staging", BUILD, 42_010, true)],
      }),
    );

    expect(hosts(desired)).toEqual([
      `${PROJECT}--${BUILD}.${DOMAIN}`,
      `${PROJECT}--staging.${DOMAIN}`,
    ]);
  });

  it("repeats every host under each platform domain", () => {
    const desired = renderRoutes(
      input({
        platformDomains: [DOMAIN, OTHER_DOMAIN],
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)],
        processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true)],
      }),
    );

    expect(hosts(desired)).toEqual([
      `${PROJECT}--${BUILD}.${OTHER_DOMAIN}`,
      `${PROJECT}--${BUILD}.${DOMAIN}`,
      `${PROJECT}--${APEX_ENVIRONMENT}.${OTHER_DOMAIN}`,
      `${PROJECT}--${APEX_ENVIRONMENT}.${DOMAIN}`,
      `${PROJECT}.${OTHER_DOMAIN}`,
      `${PROJECT}.${DOMAIN}`,
    ]);
  });
});

describe("build-hash routing", () => {
  it("keeps a superseded build reachable while its process still runs", () => {
    /* Mid-flip: the alias already names the new build and both processes are
       up, so the old one must stay inspectable under its own hash while the
       environment's own hosts have already moved. */
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)],
        processes: [
          process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true),
          process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, true),
        ],
      }),
    );

    expect(backendOf(desired, `${PROJECT}.${DOMAIN}`)?.port).toBe(42_000);
    expect(backendOf(desired, `${PROJECT}--${BUILD}.${DOMAIN}`)?.port).toBe(42_000);
    expect(backendOf(desired, `${PROJECT}--${OLDER}.${DOMAIN}`)?.port).toBe(42_002);
  });

  it("leaves the environment's own hosts to the alias when a build id would collide", () => {
    /* An environment may legally be named the same as some build. The alias
       owns the label; the hash route for that build simply has nowhere to go. */
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, OLDER, BUILD)],
        processes: [
          process(PROJECT, OLDER, BUILD, 42_000, true),
          process(PROJECT, "preview", OLDER, 42_004, true),
        ],
      }),
    );

    expect(backendOf(desired, `${PROJECT}--${OLDER}.${DOMAIN}`)).toMatchObject({
      env: OLDER,
      build: BUILD,
      port: 42_000,
    });
  });
});

describe("custom domains", () => {
  it("routes a claim to the environment's alias backend", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, ["shop.example"])],
        processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true)],
        claims: [{ host: "shop.example", project: PROJECT, environment: APEX_ENVIRONMENT }],
      }),
    );

    expect(backendOf(desired, "shop.example")).toEqual({
      project: PROJECT,
      env: APEX_ENVIRONMENT,
      build: BUILD,
      port: 42_000,
    });
  });

  it("drops a claim whose environment has nothing ready to serve it", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, ["shop.example"])],
        processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, false)],
        claims: [{ host: "shop.example", project: PROJECT, environment: APEX_ENVIRONMENT }],
      }),
    );

    expect(hosts(desired)).toEqual([]);
  });
});

describe("labels that do not fit", () => {
  it("skips the host that overflows and keeps the ones that do not", () => {
    /* `project--production` is over the DNS label limit here, while the apex
       host and the label of a shorter environment are both still buildable. */
    const long = "p".repeat(SLUG_MAX_LENGTH - 5);
    expect(`${long}--${APEX_ENVIRONMENT}`.length).toBeGreaterThan(SLUG_MAX_LENGTH);

    const desired = renderRoutes(
      input({
        environments: [environment(long, APEX_ENVIRONMENT, BUILD)],
        processes: [process(long, APEX_ENVIRONMENT, BUILD, 42_000, true)],
      }),
    );

    expect(hosts(desired)).toEqual([`${long}.${DOMAIN}`]);
  });
});

describe("determinism", () => {
  it("renders the same routing whatever order its inputs arrive in", () => {
    const environments = [
      environment("alpha", APEX_ENVIRONMENT, BUILD),
      environment("beta", "staging", OLDER),
      environment(PROJECT, APEX_ENVIRONMENT, BUILD, ["shop.example"]),
    ];
    const processes = [
      process("alpha", APEX_ENVIRONMENT, BUILD, 42_000, true),
      process("beta", "staging", OLDER, 42_002, true),
      process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_004, true),
    ];
    const claims: RouteClaim[] = [
      { host: "shop.example", project: PROJECT, environment: APEX_ENVIRONMENT },
    ];

    const forwards = renderRoutes(input({ environments, processes, claims }));
    const backwards = renderRoutes(
      input({
        environments: [...environments].reverse(),
        processes: [...processes].reverse(),
        claims: [...claims].reverse(),
      }),
    );

    expect(backwards).toEqual(forwards);
    expect(hosts(forwards)).toEqual([...hosts(forwards)].sort());
    expect(hosts(forwards)).toContain("shop.example");
  });
});

function input(overrides: Partial<RenderRoutesInput>): RenderRoutesInput {
  return {
    platformDomains: [DOMAIN],
    environments: [],
    processes: [],
    claims: [],
    ...overrides,
  };
}

function environment(
  project: string,
  name: string,
  build?: string,
  domains: string[] = [],
): { project: string; env: EnvironmentRecord } {
  return {
    project,
    env: {
      v: 1,
      name,
      prefix: `fleets/${project}/${name}`,
      alias: build === undefined ? null : { build, flippedAt: "2026-01-01T00:00:00.000Z" },
      split: null,
      domains,
      placement: "auto",
      ephemeral: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function process(
  project: string,
  env: string,
  build: string,
  port: number,
  ready: boolean,
): RuntimeProcess {
  return {
    processId: `${project}--${env}--${build}`,
    project,
    env,
    build,
    port,
    internalPort: port + 1,
    ready,
  };
}

function hosts(desired: IngressDesired): string[] {
  return desired.routes.map((route) => route.host);
}

function backendOf(
  desired: IngressDesired,
  host: string,
): IngressDesired["routes"][number]["backend"] | undefined {
  return desired.routes.find((route) => route.host === host)?.backend;
}
