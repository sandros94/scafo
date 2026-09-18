/* The routing one node renders from the applications it serves. */

import { describe, expect, it } from "vitest";
import {
  API_DENIED_PREFIXES,
  hostUnder,
  renderRoutes,
  servingBackend,
} from "../src/core/placement/routes.ts";
import { platformApplication, platformLabel } from "../src/core/placement/hosts.ts";
import type { ApplicationRecord } from "../src/core/types/registry.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";

const NAME = "shop";

describe("application routing", () => {
  it("routes every host to the running application process", () => {
    const running = process(NAME, 8100);
    expect(
      renderRoutes({
        platformDomains: ["apps.test"],
        applications: [application(NAME, ["shop.example.com"])],
        processes: [running],
        claims: [{ host: "shop.example.com", application: NAME }],
      }).routes,
    ).toEqual([
      { host: "shop.apps.test", backend: backend(running) },
      { host: "shop.example.com", backend: backend(running) },
    ]);
  });

  it("serves an application at its name under each platform domain and nowhere else", () => {
    /* The host label IS the application name: there is no second label to join
       on, and no name is treated as the apex of a platform domain. */
    const running = process("production", 8100);
    const routes = renderRoutes({
      platformDomains: ["apps.test", "edge.test"],
      applications: [application("production")],
      processes: [running],
      claims: [],
    }).routes;

    expect(routes.map((route) => route.host)).toEqual([
      "production.apps.test",
      "production.edge.test",
    ]);
  });

  it("builds a platform host as the name under the domain", () => {
    expect(hostUnder("apps.test", "shop")).toBe("shop.apps.test");
    expect(hostUnder("apps.test", "shop-preview")).toBe("shop-preview.apps.test");
    expect(hostUnder("apps.test", "a".repeat(64))).toBeNull();
  });

  it("reads a platform host back into the application it names", () => {
    expect(platformLabel("shop.apps.test", ["apps.test"])).toBe("shop");
    expect(platformApplication("shop-preview.apps.test", ["apps.test"])).toBe("shop-preview");

    /* The apex names no application, and neither does a label scafo could never
       have rendered. */
    expect(platformApplication("apps.test", ["apps.test"])).toBeNull();
    expect(platformApplication("shop--preview.apps.test", ["apps.test"])).toBeNull();
    expect(platformApplication("shop.example.com", ["apps.test"])).toBeNull();
  });

  it("routes independently of celld deployment revisions", () => {
    const running = process(NAME, 8100);
    expect(servingBackend(application(NAME), [running])).toEqual(backend(running));
  });

  it("publishes the API independently of unrouted applications", () => {
    const desired = renderRoutes({
      platformDomains: ["apps.test"],
      applications: [application("preview", ["preview.example.com"])],
      processes: [],
      claims: [],
      api: { port: 7331 },
    });
    expect(desired.routes).toEqual([]);
    expect(desired.api).toEqual({ port: 7331, hosts: ["apps.test"], denied: API_DENIED_PREFIXES });
  });
});

function application(name: string, domains: string[] = []): ApplicationRecord {
  return {
    v: 1,
    name,
    deployment: { revision: 2, deployedAt: "2026-01-01T00:00:00.000Z" },
    domains,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function process(application: string, port: number): RuntimeProcess {
  return { application, port, internalPort: port + 1 };
}

function backend(runtime: RuntimeProcess): object {
  return { application: runtime.application, port: runtime.port };
}
