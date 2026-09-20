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
import type { HostApplication } from "../src/core/placement/host-bindings.ts";
import { CLOCK_START_MS } from "./_helpers.ts";

const DOMAINS = ["apps.test", "preview.test"];
/** The custom host the wildcard cases are claimed on. */
const BASE = "shop.example.com";

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

  it("takes a custom domain from the application that claimed it", () => {
    const counters = counting();
    counters.observeApplications([application("shop", [BASE])]);

    counters.ingest(line({ host: BASE }));

    expect(named(counters)).toEqual([{ application: "shop", requests: 1 }]);
    expect(counters.snapshot().unattributed).toBe(0);
  });

  it("keeps an inactive application's custom domain attributable, because the claim outlives the route", () => {
    /* Nothing is serving it anywhere, which is a statement about processes; the
       claim is what the application's own record says regardless. */
    const counters = counting();
    counters.observeApplications([application("shop", [BASE])]);

    counters.ingest(line({ host: BASE }));

    expect(named(counters)).toEqual([{ application: "shop", requests: 1 }]);
  });

  it("stops attributing a host the registry has stopped naming", () => {
    const counters = counting();
    counters.observeApplications([application("shop", [BASE])]);
    counters.ingest(line({ host: BASE }));

    /* The application was deleted, or its domain released: the next pass states
       the registry whole, and a stale entry would go on crediting it. */
    counters.observeApplications([]);
    counters.ingest(line({ host: BASE }));

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

describe("what a wildcard claim is counted as", () => {
  /* THE NODE COUNTING SERVES NEITHER OF THESE. Attribution reads the registry
     view, which holds every application of the installation, so a host answered
     by a process on some other node is still counted as whose it is. */
  const applications = [
    covering(application("shop", [BASE]), [BASE]),
    application("shop-preview"),
    application("blog"),
  ];

  it("counts the base, an environment and the catch-all as the routing would answer them", () => {
    const counters = counting();
    counters.observeApplications(applications);

    /* Rule 1: the base itself. Rule 2: the environment one label under it.
       Rule 3: every other name one label under it. */
    counters.ingest(line({ host: BASE }));
    counters.ingest(line({ host: `preview.${BASE}` }));
    counters.ingest(line({ host: `staging.${BASE}` }));
    counters.ingest(line({ host: `blog.${BASE}` }));

    expect(counters.snapshot().unattributed).toBe(0);
    expect(named(counters)).toEqual([
      { application: "shop", requests: 3 },
      { application: "shop-preview", requests: 1 },
    ]);
  });

  it("counts a name two labels under the base as nobody's", () => {
    const counters = counting();
    counters.observeApplications(applications);

    counters.ingest(line({ host: `a.preview.${BASE}` }));

    expect(counters.snapshot().unattributed).toBe(1);
  });

  it("counts an environment the installation has no application for as the holder's", () => {
    const counters = counting();
    counters.observeApplications([covering(application("shop", [BASE]), [BASE])]);

    counters.ingest(line({ host: `preview.${BASE}` }));

    expect(named(counters)).toEqual([{ application: "shop", requests: 1 }]);
  });

  it("leaves an installation that claimed no wildcard counting exactly as before", () => {
    const counters = counting();
    counters.observeApplications([application("shop", [BASE]), application("shop-preview")]);

    counters.ingest(line({ host: BASE }));
    counters.ingest(line({ host: `preview.${BASE}` }));

    const snapshot = counters.snapshot();
    expect(snapshot.unattributed).toBe(1);
    expect(named(counters)).toEqual([
      { application: UNATTRIBUTED, requests: 1 },
      { application: "shop", requests: 1 },
    ]);
  });

  it("lets an exact claim under the base win over the wildcard enclosing it", () => {
    const counters = counting();
    counters.observeApplications([
      covering(application("shop", [BASE]), [BASE]),
      application("blog", [`blog.${BASE}`]),
    ]);

    counters.ingest(line({ host: `blog.${BASE}` }));

    expect(named(counters)).toEqual([{ application: "blog", requests: 1 }]);
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

/** An application as attribution reads one: its name and the hosts claimed for it. */
function application(name: string, domains: string[] = []): HostApplication {
  return { name, domains };
}

/** The same record with some of its hosts claimed WITH their subdomains. */
function covering(record: HostApplication, hosts: string[]): HostApplication {
  return { ...record, wildcardDomains: hosts };
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
