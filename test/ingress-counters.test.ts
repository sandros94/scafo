/*
 * What the ingress served, counted per application: which host is read as whose,
 * what a status and a latency land in, and what a snapshot promises.
 */

import { describe, expect, it } from "vitest";
import {
  createIngressCounters,
  DURATION_BANDS_MS,
  type IngressBucket,
  type IngressCounters,
  UNATTRIBUTED,
} from "../src/daemon/access-counters.ts";
import { recordRouting } from "../src/daemon/_ingress.ts";
import type { DaemonContext } from "../src/daemon/app.ts";
import { API_DENIED_PREFIXES } from "../src/core/placement/routes.ts";
import type { IngressRoute } from "../src/core/types/ingress.ts";
import type { ApplicationRecord } from "../src/core/types/registry.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";
import { CLOCK_START_MS } from "./_helpers.ts";

const DOMAINS = ["apps.test", "preview.test"];

describe("what a host is counted as", () => {
  it("reads an application's name off the host grammar alone", () => {
    /* Nothing has to be routed for this: host grammar alone is enough to
       attribute an application's traffic. */
    const counters = counting();
    counters.ingest(line({ host: "shop-preview.apps.test" }));
    counters.ingest(line({ host: "shop.apps.test" }));
    counters.ingest(line({ host: "shop-preview.preview.test" }));

    expect(named(counters)).toEqual([
      { application: "shop", requests: 1 },
      { application: "shop-preview", requests: 2 },
    ]);
  });

  it("takes a custom domain from the routing, which is the only thing that knows", () => {
    const counters = counting();
    counters.observeRouting({
      routes: [route("shop.example.com", "shop")],
      claims: [{ host: "shop.example.com", application: "shop" }],
    });

    counters.ingest(line({ host: "shop.example.com" }));

    expect(named(counters)).toEqual([{ application: "shop", requests: 1 }]);
    expect(counters.snapshot().unattributed).toBe(0);
  });

  it("keeps an inactive application's custom domain attributable, because the claim outlives the route", () => {
    /* Nothing is ready, so the routing carries no route for it at all; the claim
       is what an application's record says regardless. */
    const counters = counting();
    counters.observeRouting({
      routes: [],
      claims: [{ host: "shop.example.com", application: "shop" }],
    });

    counters.ingest(line({ host: "shop.example.com" }));

    expect(named(counters)).toEqual([{ application: "shop", requests: 1 }]);
  });

  it("lets the routing win over the platform-host grammar", () => {
    const counters = counting();
    counters.observeRouting({
      routes: [route("shop.apps.test", "shop-preview")],
      claims: [],
    });

    counters.ingest(line({ host: "shop.apps.test" }));

    /* Read off the grammar alone this is "shop"; the published routing is the
       authority for what the request actually reached. */
    expect(named(counters)).toEqual([{ application: "shop-preview", requests: 1 }]);
  });

  it("stops attributing a host the routing has stopped naming", () => {
    const counters = counting();
    counters.observeRouting({
      routes: [],
      claims: [{ host: "shop.example.com", application: "shop" }],
    });
    counters.ingest(line({ host: "shop.example.com" }));

    /* The application was deleted, or its domain released: the next pass states
       the routing whole, and a stale entry would go on crediting it. */
    counters.observeRouting({ routes: [], claims: [] });
    counters.ingest(line({ host: "shop.example.com" }));

    const snapshot = counters.snapshot();
    expect(snapshot.unattributed).toBe(1);
    expect(named(counters)).toEqual([
      { application: UNATTRIBUTED, requests: 1 },
      { application: "shop", requests: 1 },
    ]);
  });

  it("counts a name nothing answers to in full, under its own bucket", () => {
    const counters = counting();
    /* A domain this installation never minted, an address, and a label no host
       could have been rendered from. */
    counters.ingest(line({ host: "totally.elsewhere.test", size: 30, status: 404 }));
    counters.ingest(line({ host: "203.0.113.9", size: 12, status: 404 }));
    counters.ingest(line({ host: "a--b--c.apps.test", size: 0, status: 404 }));

    const snapshot = counters.snapshot();
    expect(snapshot.unattributed).toBe(3);
    expect(snapshot.buckets).toHaveLength(1);
    expect(snapshot.buckets[0]).toMatchObject({
      application: UNATTRIBUTED,
      requests: 3,
      bytes: 42,
    });
  });

  it("never lets the unattributed bucket collide with a real application", () => {
    /* The sentinel is not a slug, so no application can ever be named it and no
       real traffic can ever be added into it. */
    const counters = counting();
    counters.ingest(line({ host: `${UNATTRIBUTED}.apps.test` }));

    expect(counters.snapshot().unattributed).toBe(1);
    expect(named(counters)).toEqual([{ application: UNATTRIBUTED, requests: 1 }]);
  });
});

describe("what is counted", () => {
  it("puts each answer in its status class, and anything outside 200-599 apart", () => {
    const counters = counting();
    for (const status of [200, 204, 301, 404, 429, 500, 503, 101, 999]) {
      counters.ingest(line({ host: "shop.apps.test", status }));
    }

    expect(counters.snapshot().buckets[0].status).toEqual({
      "2xx": 2,
      "3xx": 1,
      "4xx": 2,
      "5xx": 2,
      "other": 2,
    });
  });

  it("adds up the bytes the ingress reported writing", () => {
    const counters = counting();
    counters.ingest(line({ host: "shop.apps.test", size: 1_024 }));
    counters.ingest(line({ host: "shop.apps.test", size: 512 }));

    expect(counters.snapshot().buckets[0]).toMatchObject({ requests: 2, bytes: 1_536 });
  });

  it("lands a request in the first band its duration does not exceed", () => {
    const counters = counting();
    /* One on each boundary and one past the last, so the boundaries themselves
       are pinned rather than the gaps between them. */
    for (const durationMs of [...DURATION_BANDS_MS, 9_999]) {
      counters.ingest(line({ host: "shop.apps.test", durationMs }));
    }

    expect(counters.snapshot().buckets[0].durations).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(counters.snapshot().buckets[0].durations).toHaveLength(DURATION_BANDS_MS.length + 1);
  });

  it("puts a fast request in the first band and a slow one in the last", () => {
    const counters = counting();
    counters.ingest(line({ host: "shop.apps.test", durationMs: 0.084 }));
    counters.ingest(line({ host: "shop.apps.test", durationMs: 60_000 }));

    expect(counters.snapshot().buckets[0].durations).toEqual([1, 0, 0, 0, 0, 0, 1]);
  });

  it("counts a line no format could be read out of as malformed, and as no request", () => {
    const counters = counting();
    counters.ingest(line({ host: "shop.apps.test" }));
    counters.ingest("not json at all");
    counters.ingest('{"level":"info","logger":"tls","msg":"cleaning storage unit"}');
    counters.ingest("");

    const snapshot = counters.snapshot();
    /* Every line read is counted as one, which is what makes a malformed count
       readable: pointed at the wrong file, the two track each other. */
    expect(snapshot).toMatchObject({ lines: 4, malformed: 3, unattributed: 0 });
    expect(snapshot.buckets[0].requests).toBe(1);
  });

  it("counts both formats into the same bucket", () => {
    const counters = counting();
    counters.ingest(line({ host: "shop.apps.test", status: 200, size: 10, durationMs: 5 }));
    counters.ingest(
      JSON.stringify({
        RequestHost: "shop.apps.test",
        RequestMethod: "GET",
        DownstreamStatus: 200,
        DownstreamContentSize: 10,
        Duration: 5_000_000,
      }),
    );

    expect(counters.snapshot().buckets[0]).toMatchObject({ requests: 2, bytes: 20 });
    /* Caddy's seconds and Traefik's nanoseconds are the same 5ms, and they land
       in the same band — which is the whole point of reading both. */
    expect(counters.snapshot().buckets[0].durations).toEqual([2, 0, 0, 0, 0, 0, 0]);
  });
});

describe("the snapshot", () => {
  it("is stamped from the injected clock and reports totals since then", () => {
    const counters = createIngressCounters({
      platformDomains: DOMAINS,
      now: (): Date => new Date(CLOCK_START_MS),
    });

    expect(counters.snapshot().since).toBe(new Date(CLOCK_START_MS).toISOString());
  });

  it("does not consume, and does not reset: two readers see the same totals", () => {
    const counters = counting();
    counters.ingest(line({ host: "shop.apps.test" }));

    const first = counters.snapshot();
    const second = counters.snapshot();

    expect(second).toEqual(first);
    expect(second.buckets[0].requests).toBe(1);
  });

  it("hands out a copy, so a reader cannot reach back into the counters", () => {
    const counters = counting();
    counters.ingest(line({ host: "shop.apps.test" }));

    const snapshot = counters.snapshot();
    snapshot.buckets[0].requests = 999;
    snapshot.buckets[0].status["2xx"] = 999;
    snapshot.buckets[0].durations[0] = 999;
    snapshot.buckets.push(snapshot.buckets[0]);

    const again = counters.snapshot();
    expect(again.buckets).toHaveLength(1);
    expect(again.buckets[0]).toMatchObject({ requests: 1 });
    expect(again.buckets[0].status["2xx"]).toBe(1);
  });

  it("sorts by application name, so two snapshots line up", () => {
    const counters = counting();
    for (const host of [
      "zeta.apps.test",
      "shop-staging.apps.test",
      "alpha-preview.apps.test",
      "shop-preview.apps.test",
    ]) {
      counters.ingest(line({ host }));
    }

    expect(counters.snapshot().buckets.map((bucket) => bucket.application)).toEqual([
      "alpha-preview",
      "shop-preview",
      "shop-staging",
      "zeta",
    ]);
  });
});

describe("what the reconcile pass hands over", () => {
  it("attributes off the same routing the node renders for itself", () => {
    /* The attribution is not a second reading of what serves an application —
       it is the routing itself, read where it is rendered. A second reading
       would drift from what traffic actually reaches. */
    const counters = counting();
    const daemon = daemonWith(counters, true);

    const routing = recordRouting(daemon, {
      desired: [application("shop", ["shop.example.com"])],
      processes: [process_("shop", 9101)],
    });

    /* Exactly the hosts the pass rendered, each read as the application the
       ingress reading them will send them to. */
    expect(routing.routes.map((entry) => entry.host)).toContain("shop.example.com");

    for (const host of ["shop.apps.test", "shop.preview.test", "shop.example.com"]) {
      counters.ingest(line({ host }));
    }

    expect(counters.snapshot().unattributed).toBe(0);
    expect(named(counters)).toEqual([{ application: "shop", requests: 3 }]);
  });

  it("publishes the platform apexes as the fleet's API, or not at all", () => {
    /* The one thing `api.public` does to the routing, at the seam that reads it:
       the apexes are named with the daemon's own port, or the routing carries no
       `api` at all and is what scafo rendered before the apex answered. */
    for (const isPublic of [true, false]) {
      const routing = recordRouting(daemonWith(undefined, isPublic), {
        desired: [],
        processes: [],
      });

      expect(routing.api, String(isPublic)).toEqual(
        isPublic
          ? { port: 7400, hosts: [...DOMAINS].sort(), denied: API_DENIED_PREFIXES }
          : undefined,
      );
    }
  });
});

/** Just enough daemon for the routing seam: the domains, the port, and the switch. */
function daemonWith(counters: IngressCounters | undefined, apiPublic: boolean): DaemonContext {
  return {
    config: {
      platformDomains: DOMAINS,
      node: { listen: "127.0.0.1:7400" },
      api: { public: apiPublic, jsonBytes: 65_536 },
    },
    ...(counters === undefined ? {} : { ingressCounters: counters }),
  } as unknown as DaemonContext;
}

function counting(): IngressCounters {
  return createIngressCounters({
    platformDomains: DOMAINS,
    now: (): Date => new Date(CLOCK_START_MS),
  });
}

/** A Caddy access-log line stating exactly what a case cares about. */
function line(over: { host: string; status?: number; size?: number; durationMs?: number }): string {
  return JSON.stringify({
    level: "info",
    logger: "http.log.access.scafo",
    msg: "handled request",
    request: { method: "GET", host: over.host, uri: "/", proto: "HTTP/1.1" },
    duration: (over.durationMs ?? 1) / 1_000,
    size: over.size ?? 0,
    status: over.status ?? 200,
  });
}

function route(host: string, application: string): IngressRoute {
  return { host, backend: { application, port: 9101 } };
}

/** An application record carrying only what the routing is rendered from. */
function application(name: string, domains: string[]): ApplicationRecord {
  return {
    v: 1,
    name,
    deployment: { revision: 1, deployedAt: new Date(CLOCK_START_MS).toISOString() },
    domains,
    createdAt: new Date(CLOCK_START_MS).toISOString(),
  };
}

/** A supervised process, which is the only kind the routing ever names. */
function process_(application: string, port: number): RuntimeProcess {
  return { application, port, internalPort: port + 1 };
}

/** Each bucket as the application it names and what it counted, for a case that only wants that. */
function named(counters: IngressCounters): Array<
  Pick<IngressBucket, "application"> & {
    requests: number;
  }
> {
  return counters.snapshot().buckets.map((bucket) => ({
    application: bucket.application,
    requests: bucket.requests,
  }));
}
