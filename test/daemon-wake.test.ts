/*
 * The wake surface, reached the way a request off the wire reaches it: through
 * the node app, decided by the `Host` header alone.
 *
 * HOST DISPATCH COMES BEFORE EVERYTHING, and that is what most of this file is
 * about. A host the ingress had nothing else to do with never reaches a route —
 * no API path, no token, and no fall into an API 404 either — while the node's
 * own API is untouched by any of it.
 *
 * WHICH NODE BOOTS is the other half. A wake lands wherever the routing put it,
 * and the node that starts the process is one the placement chose: this node
 * serves what it was given, hands what it was not to a live node that was, and
 * never passes on a request another node already forwarded to it.
 *
 * Nothing binds a socket. The app is driven through its fetch interface, the
 * reconcile loop is a stand-in whose processes a case brings up by hand, and
 * both hops a held request can take — down to a process, across to a peer's
 * daemon — are the daemon's injected `fetch`.
 */

import type { H3 } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { beforeEach, describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import type { ParkedEnvironment } from "../src/daemon/_desired.ts";
import { type DaemonContext, type DaemonState, createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import {
  createObservability,
  type Observability,
  type ObservedEvent,
} from "../src/daemon/observe.ts";
import type { Reconciler } from "../src/daemon/reconcile.ts";
import {
  FALLBACK_MAX_CONCURRENT_WAKES,
  WAKE_HEADER,
  WAKE_POLL_INTERVAL_MS,
  WAKE_RETRY_AFTER_S,
  type WakeCounters,
} from "../src/daemon/wake.ts";
import type { CapacityPlan } from "../src/core/capacity/compute.ts";
import type { ProblemDetails } from "../src/core/error.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import {
  acquireLease,
  claimDomain,
  createBuild,
  createEnvironment,
  createProject,
  drainNode,
  getEnvironment,
  type LeaseHandle,
  readEnvironmentWake,
  registerNode,
  retireEnvironment,
  setNodeSelector,
  setParkPolicy,
  writePlacement,
} from "../src/core/registry/index.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const NODE_ID = "node-a";
/** A second node of the same installation, and where its daemon is reached. */
const PEER = "node-b";
const SELF_ADDRESS = { internal: "10.0.0.4", apiPort: 7400 };
const PEER_ADDRESS = { internal: "10.0.0.5", apiPort: 7500 };
const VERSION = "0.0.0-test";
const DOMAIN = "apps.test";
const PROJECT = "shop";
/** Two parked environments: one to wake, one to be turned away while it is. */
const PREVIEW = "preview";
const OTHER_PREVIEW = "staging";
/** An environment on its way out, and a recorded build-shaped name. */
const RETIRED = "gone";
const ORPHAN_BUILD = "cccc3333";
const BUILD = "aaaa1111";
const SUPERSEDED = "bbbb2222";
/** A third build of the same environment, for the cases that weigh two legs. */
const THIRD = "dddd4444";
const CUSTOM = "shop.example.com";

const PARKED_HOST = `${PROJECT}--${PREVIEW}.${DOMAIN}`;
const OTHER_PARKED_HOST = `${PROJECT}--${OTHER_PREVIEW}.${DOMAIN}`;

/** What the process a wake brings up answers with; the surface must relay it whole. */
const UPSTREAM_BODY = "served by the build";
/** What the PEER's daemon answers a forwarded wake with; the surface relays that whole too. */
const PEER_BODY = "served by node-b";

/** One call a hop made — to a loopback process or to a peer — as the stand-in saw it. */
interface UpstreamCall {
  url: string;
  method: string;
  headers: Headers;
  /** What was streamed on, or null when the request had no body. */
  body: string | null;
}

let clock: ManualClock;
let keys: { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };
let lease: LeaseHandle;
let loop: FakeReconciler;
let upstream: UpstreamCall[];
let observe: Observability;
let app: H3;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  observe = createObservability({ enabled: true, now: (): Date => new Date(clock.nowMs()) });
  keys = await generateJWK("EdDSA", { kid: NODE_ID });
  await registerNode(clock.ctx, {
    v: 1,
    id: NODE_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    addresses: SELF_ADDRESS,
  });
  /* A live peer: a placement is only forwarded to a node that has reported in. */
  await registerNode(clock.ctx, {
    v: 1,
    id: PEER,
    publicKey: { kty: "OKP", crv: "Ed25519", x: "b".repeat(43) },
    addresses: PEER_ADDRESS,
    heartbeatAt: new Date(clock.nowMs()).toISOString(),
  });

  const acquired = await acquireLease(clock.ctx, NODE_ID);
  if (acquired === null) throw new Error("the fixture could not take the lease");
  lease = acquired;

  loop = fakeReconciler();
  upstream = [];
  app = appWith({});
  await seed();
});

describe("which surface a request lands on", () => {
  it("answers a wake host on EVERY path, with no route and no token", async () => {
    loop.onKick = (): void => {
      loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    };

    for (const path of ["/", "/v1/health", "/v1/state", "/deep/path?id=7"]) {
      const response = await ask(PARKED_HOST, path);

      /* `/v1/state` is a 401 on the API surface and `/v1/health` a 200 of its
         own, so the body is what says which surface answered. */
      expect(response.status, path).toBe(200);
      await expect(response.text(), path).resolves.toBe(UPSTREAM_BODY);
    }
    expect(upstream.map((call) => new URL(call.url).pathname)).toEqual([
      "/",
      "/v1/health",
      "/v1/state",
      "/deep/path",
    ]);
  });

  it("leaves the node's own API to the API", async () => {
    const health = await app.request("/v1/health");
    const state = await app.request("/v1/state");

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ node: NODE_ID });
    expect(state.status).toBe(401);
    /* Nothing was proxied and nothing was woken on the way. */
    expect(upstream).toEqual([]);
    expect(loop.kicks).toBe(0);
  });

  it("keeps the platform domain ITSELF on the API surface", async () => {
    /* The catch-all covers exactly one label, so the apex domain is nobody's
       project and a request for it is not asking for one. */
    const response = await ask(DOMAIN, "/v1/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ node: NODE_ID });
  });

  it("answers a path the API does not have at the apex as the API's own 404", async () => {
    /* The ingress routes the apex here for the ROUTES to answer, so a path they
       do not carry is their miss — `about:blank`, the shape every unrouted API
       path wears — rather than the wake surface's "nothing is served at this
       host". Nothing is woken and nothing is proxied on the way. */
    const response = await ask(DOMAIN, "/v1/nope");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({ type: "about:blank", status: 404 });
    expect(upstream).toEqual([]);
    expect(loop.kicks).toBe(0);
  });

  it("keeps it on the API surface even against a parked environment's claim on it", async () => {
    /* The one case where the two surfaces both want the bare apex: an
       environment claimed the platform domain itself as a custom domain. While
       the API is published there, the API wins. */
    await claimDomain(clock.ctx, DOMAIN, PROJECT, OTHER_PREVIEW);
    loop.parked = [
      { project: PROJECT, env: await getEnvironment(clock.ctx, PROJECT, PREVIEW) },
      { project: PROJECT, env: await getEnvironment(clock.ctx, PROJECT, OTHER_PREVIEW) },
    ];

    const response = await ask(DOMAIN, "/v1/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ node: NODE_ID });
    expect(upstream).toEqual([]);
  });

  it("gives the apex back to the wake surface when the API is not published there", async () => {
    /* `api.public` off: the apex is nothing the routing sends here for the API,
       so the claim on it is the only thing left and it wakes exactly as any
       other custom domain does. */
    await claimDomain(clock.ctx, DOMAIN, PROJECT, OTHER_PREVIEW);
    loop.parked = [
      { project: PROJECT, env: await getEnvironment(clock.ctx, PROJECT, OTHER_PREVIEW) },
    ];
    loop.onKick = (): void => {
      loop.processes = [ready(OTHER_PREVIEW, BUILD, 42_006)];
    };

    const closed = appWith({ apiPublic: false });
    const response = await closed.request("/v1/health", { headers: { host: DOMAIN } });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(UPSTREAM_BODY);
  });

  it("reads x-forwarded-host ONLY on a hop another node marked", async () => {
    const spoofed = await app.request("/v1/health", {
      headers: {
        "host": `${SELF_ADDRESS.internal}:${String(SELF_ADDRESS.apiPort)}`,
        "x-forwarded-host": PARKED_HOST,
      },
    });

    /*
     * An ingress in front of the daemon sets `x-forwarded-host` on every request
     * it proxies, Caddy included. Honouring it unmarked would let that ingress
     * decide which surface answers, so the node's own API answers here.
     */
    expect(spoofed.status).toBe(200);
    await expect(spoofed.json()).resolves.toMatchObject({ node: NODE_ID });
    expect(upstream).toEqual([]);
    expect(loop.kicks).toBe(0);

    /* The same request marked as one node's hop to another: now the name in the
       header is the one the surface answers for, API path or not. */
    loop.onKick = (): void => {
      loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    };
    const hop = await forwardedAsk(PARKED_HOST, "/v1/health");

    expect(hop.status).toBe(200);
    await expect(hop.text()).resolves.toBe(UPSTREAM_BODY);
  });

  it("takes a parked environment's custom domain, which is under no platform domain", async () => {
    loop.onKick = (): void => {
      loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    };

    const response = await ask(CUSTOM, "/");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(UPSTREAM_BODY);
  });
});

describe("a name this installation has nothing to serve at", () => {
  it("answers 404 as a problem document, with nothing to come back for", async () => {
    const host = `${PROJECT}--ghost.${DOMAIN}`;

    const response = await ask(host, "/whatever");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    /* No `Retry-After`: this is not a wait, it is an answer. */
    expect(response.headers.get("retry-after")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      type: "urn:scafo:not-found",
      title: "Nothing is served at this host",
      status: 404,
      detail: `"${host}" names nothing this installation serves`,
    });
    expect(loop.kicks).toBe(0);
  });

  it("gives every way of getting there the SAME document", async () => {
    const ways: Array<[host: string, why: string]> = [
      [`${PROJECT}--ghost.${DOMAIN}`, "an environment that was never deployed"],
      [`${PROJECT}--deadbeef.${DOMAIN}`, "a build-shaped environment that does not exist"],
      [`${PROJECT}--${RETIRED}.${DOMAIN}`, "an environment that was retired"],
      [`${PROJECT}--${ORPHAN_BUILD}.${DOMAIN}`, "a recorded build ID that is not an environment"],
      [`ghost--${PREVIEW}.${DOMAIN}`, "a project that does not exist"],
    ];

    const shapes = new Set<string>();
    for (const [host, why] of ways) {
      const response = await ask(host, "/");
      const problem = (await response.json()) as ProblemDetails;

      expect(response.status, why).toBe(404);
      shapes.add(JSON.stringify({ ...problem, detail: String(problem.detail).replace(host, "") }));
    }

    /*
     * It says nothing about which way that was — never deployed, retired, or a
     * recorded build ID without an environment — and it is permanent by design rather than by
     * omission: the bucket is the source of truth, and a record deleted from it
     * does not come back.
     */
    expect([...shapes]).toHaveLength(1);
  });
});

describe("waking what this node has parked", () => {
  it("stamps, kicks, and hands the request to the process that comes up", async () => {
    loop.onKick = (): void => {
      loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    };

    const response = await ask(PARKED_HOST, "/cart?id=7");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(UPSTREAM_BODY);
    /* Converge NOW rather than at the end of the interval: the whole of a wake's
       latency that scafo controls is the gap between the stamp and the pass that
       reads it. */
    expect(loop.kicks).toBe(1);
    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.toEqual(
      new Date(clock.nowMs()),
    );

    expect(upstream).toHaveLength(1);
    expect(upstream[0].url).toBe("http://127.0.0.1:42004/cart?id=7");
    /* The process is dialled by address, so the name that was asked for travels
       as the header the ingress would have sent. */
    expect(upstream[0].headers.get("x-forwarded-host")).toBe(PARKED_HOST);
    expect(upstream[0].headers.get("host")).toBeNull();
  });

  it("holds the request until something is ready, rather than answering early", async () => {
    const held = ask(PARKED_HOST, "/");
    await sleep(WAKE_POLL_INTERVAL_MS / 2);

    /* Polled rather than subscribed to: readiness is a fact about a process the
       loop re-establishes on every pass, and there is nothing here to keep in
       sync. */
    expect(upstream).toEqual([]);
    loop.processes = [ready(PREVIEW, BUILD, 42_004)];

    expect((await held).status).toBe(200);
    expect(upstream).toHaveLength(1);
  });

  it("says to come back when nothing was ready in time", async () => {
    await setParkPolicy(clock.ctx, PROJECT, PREVIEW, { wakeDeadlineS: 1 });

    const response = await ask(PARKED_HOST, "/");

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe(String(WAKE_RETRY_AFTER_S));
    await expect(response.json()).resolves.toMatchObject({
      type: "urn:scafo:wake-unavailable",
      title: "Not woken in time",
    });
    /* It keeps starting, so asking again is what this waits for: the stamp
       stands and the loop was told to converge. */
    expect(loop.kicks).toBe(1);
    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.not.toBeNull();
    /* Admitted and left admitted: `refused` counts the wakes turned away AT the
       cap, which this one was not. */
    await expect(counters()).resolves.toEqual({
      inFlight: 0,
      admitted: 1,
      refused: 0,
      forwarded: 0,
    });
  });

  it("refuses a wake AT the cap, and starts NOTHING for it", async () => {
    app = appWith({ maxConcurrentWakes: 1 });
    const held = ask(PARKED_HOST, "/");
    await sleep(WAKE_POLL_INTERVAL_MS / 2);

    const refused = await ask(OTHER_PARKED_HOST, "/");

    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe(String(WAKE_RETRY_AFTER_S));
    await expect(refused.json()).resolves.toMatchObject({
      type: "urn:scafo:wake-unavailable",
      title: "This node is already waking as much as it can",
    });
    /*
     * THE CAP IS ON ADMISSION, NOT ON BOOTS. A refused wake writes NO stamp, so
     * nothing is started on behalf of a request that was already turned away —
     * which is what keeps a crawler walking a platform domain from turning a
     * node into a boot farm, since the loop only ever starts what a stamp asked
     * for.
     */
    await expect(readEnvironmentWake(clock.ctx, PROJECT, OTHER_PREVIEW)).resolves.toBeNull();
    expect(loop.kicks).toBe(1);

    loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    expect((await held).status).toBe(200);
    /* And the slot comes back however the request that held it ended. */
    await expect(counters()).resolves.toEqual({
      inFlight: 0,
      admitted: 1,
      refused: 1,
      forwarded: 0,
    });
  });

  it("wakes one thing at a time on a node that never probed its hardware", async () => {
    app = appWith({ capacity: false });
    const held = ask(PARKED_HOST, "/");
    await sleep(WAKE_POLL_INTERVAL_MS / 2);

    const refused = await ask(OTHER_PARKED_HOST, "/");

    /* The floor the capacity formula itself guarantees: a node that knows
       nothing about its hardware wakes one thing at a time rather than guessing. */
    expect(FALLBACK_MAX_CONCURRENT_WAKES).toBe(1);
    expect(refused.status).toBe(503);

    loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    expect((await held).status).toBe(200);
  });

  it("refuses on a node that runs no reconcile loop at all", async () => {
    app = appWith({ reconciler: false });

    const response = await ask(PARKED_HOST, "/");

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe(String(WAKE_RETRY_AFTER_S));
    await expect(response.json()).resolves.toMatchObject({
      type: "urn:scafo:wake-unavailable",
      title: "This node cannot wake anything",
    });
    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.toBeNull();
  });
});

describe("what a woken host is answered with", () => {
  it("answers an environment through its stable ready process", async () => {
    /*
     * THE REPLACEMENT WINDOW, and it is minutes wide rather than milliseconds: a
     * process is stopped only once every desired leg is ready, so the preceding
     * build keeps running for passes after the ingress has moved off
     * it. It is listed FIRST here because that is the order the loop reports it
     * in — it started first — so anything answering with the first ready process
     * of the environment would serve it.
     */
    loop.processes = [ready(PREVIEW, SUPERSEDED, 42_006), ready(PREVIEW, BUILD, 42_004)];

    for (const path of ["/", "/cart", "/checkout"]) {
      expect((await ask(PARKED_HOST, path)).status, path).toBe(200);
    }

    expect(dialled()).toEqual([42_006, 42_006, 42_006]);
  });

  it("answers a custom domain with the same leg its environment's own hosts get", async () => {
    loop.processes = [ready(PREVIEW, SUPERSEDED, 42_006), ready(PREVIEW, BUILD, 42_004)];

    expect((await ask(CUSTOM, "/")).status).toBe(200);

    expect(dialled()).toEqual([42_006]);
  });

  it("keeps the ready generation available while adoption is pending", async () => {
    loop.processes = [ready(PREVIEW, SUPERSEDED, 42_006)];

    expect((await ask(PARKED_HOST, "/")).status).toBe(200);
    expect(dialled()).toEqual([42_006]);
    expect(loop.kicks).toBe(1);
  });
});

describe("where a woken process is dialled", () => {
  /*
   * THE HOP GOES WHERE THE PROCESS BINDS, WHICH IS NOT ALWAYS LOOPBACK. Three
   * dialers of one node ask the same question — the readiness gate (`probeHost`),
   * the ingress (`upstreamHost`) and this hop — and on a tunnelled fleet the
   * listeners are on the node's WireGuard address, where `127.0.0.1` answers
   * nothing at all: the wake stamps, kicks, waits out the whole boot and then
   * fails the request it did all of that for.
   *
   * WHY NO END-TO-END SUITE SEES IT: their nodes bind a wildcard, and a wildcard
   * answers on loopback too, so a hop hardcoded to loopback is indistinguishable
   * from a correct one there. It takes a bind host that is neither loopback nor a
   * wildcard, which is exactly what a fleet on a tunnel runs.
   */
  it("dials the address the processes BIND rather than loopback", async () => {
    app = appWith({ bindHost: "10.83.0.1" });
    loop.onKick = (): void => {
      loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    };

    const response = await ask(PARKED_HOST, "/cart?id=7");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(UPSTREAM_BODY);
    expect(upstream.map((call) => call.url)).toEqual(["http://10.83.0.1:42004/cart?id=7"]);
    /* The name asked for still travels as the header an ingress would have sent;
       only where the request was addressed changed. */
    expect(upstream[0].headers.get("x-forwarded-host")).toBe(PARKED_HOST);
  });

  it("dials loopback for a wildcard bind, and for the default", async () => {
    /* Loopback is among what a wildcard answers on, so the exact address is not
       needed there — and a node that configured nothing binds loopback anyway. */
    for (const bindHost of ["0.0.0.0", "::", "127.0.0.1"]) {
      upstream = [];
      loop.processes = [ready(PREVIEW, BUILD, 42_004)];
      app = appWith(bindHost === "127.0.0.1" ? {} : { bindHost });

      expect((await ask(PARKED_HOST, "/")).status, bindHost).toBe(200);
      expect(
        upstream.map((call) => call.url),
        bindHost,
      ).toEqual(["http://127.0.0.1:42004/"]);
    }
  });

  it("leaves the peer hop alone, which is dialled at what the node advertises", async () => {
    await placedOn(PREVIEW, [PEER]);
    app = appWith({ bindHost: "10.83.0.1" });

    const response = await ask(PARKED_HOST, "/");

    /* A forward is addressed to the peer's own daemon, from its registry record —
       it has nothing to do with where either node's processes listen. */
    expect(response.status).toBe(201);
    expect(upstream.map((call) => call.url)).toEqual([
      `http://${PEER_ADDRESS.internal}:${String(PEER_ADDRESS.apiPort)}/`,
    ]);
  });
});

describe("which node a wake runs on", () => {
  it("wakes it here when the placement names this node", async () => {
    await placedOn(PREVIEW, [NODE_ID, PEER]);
    loop.onKick = (): void => {
      loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    };

    const response = await ask(PARKED_HOST, "/cart?id=7");

    /* The local flow, unchanged: stamp, kick, hand it to the process. */
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(UPSTREAM_BODY);
    expect(upstream.map((call) => call.url)).toEqual(["http://127.0.0.1:42004/cart?id=7"]);
    expect(loop.kicks).toBe(1);
    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.not.toBeNull();
  });

  it("holds an unplaced wake here until an assigned process appears", async () => {
    loop.onKick = (): void => {
      loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    };

    const response = await ask(PARKED_HOST, "/");

    /* Missing placement chooses only the local waiting venue: stamp demand and
       kick reconciliation. The harness then simulates the coordinator assigning
       this node and its production reconciler making the process ready; absence
       itself is not permission to start or serve the environment. */
    expect(response.status).toBe(200);
    expect(upstream.map((call) => call.url)).toEqual(["http://127.0.0.1:42004/"]);
    expect(loop.kicks).toBe(1);
    await expect(counters()).resolves.toEqual({
      inFlight: 0,
      admitted: 1,
      refused: 0,
      forwarded: 0,
    });
  });

  it("holds a selector-bearing environment nobody has placed, then says to come back", async () => {
    await setNodeSelector(clock.ctx, PROJECT, PREVIEW, { tier: "fast" });
    await setParkPolicy(clock.ctx, PROJECT, PREVIEW, { wakeDeadlineS: 1 });

    const response = await ask(PARKED_HOST, "/");

    /*
     * An explicit constraint and no decision yet: nobody serves it, this node
     * least of all. It is held here under the environment's own deadline rather
     * than answered at once, because the stamp below is what the coordinator's
     * next pass has to place — and when that lands in time, the node it lands on
     * is what this request is handed to.
     */
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe(String(WAKE_RETRY_AFTER_S));
    await expect(response.json()).resolves.toMatchObject({
      type: "urn:scafo:wake-unavailable",
      title: "Not woken in time",
    });
    expect(upstream).toEqual([]);
    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.not.toBeNull();
    expect(loop.kicks).toBe(1);
  });

  it("forwards to the node the placement named, and relays its answer whole", async () => {
    await placedOn(PREVIEW, [PEER]);

    const response = await app.request("/cart?id=7", {
      method: "POST",
      body: "one order",
      headers: { "host": PARKED_HOST, "content-type": "text/plain" },
    });

    /* The peer's answer IS the answer: status, body and headers as it wrote
       them, because what answers a wake is the application, not a summary. */
    expect(response.status).toBe(201);
    await expect(response.text()).resolves.toBe(PEER_BODY);
    expect(response.headers.get("x-served-by")).toBe(PEER);

    expect(upstream).toHaveLength(1);
    const hop = upstream[0];
    expect(hop.url).toBe(
      `http://${PEER_ADDRESS.internal}:${String(PEER_ADDRESS.apiPort)}/cart?id=7`,
    );
    expect(hop.method).toBe("POST");
    expect(hop.body).toBe("one order");
    expect(hop.headers.get("content-type")).toBe("text/plain");
    /* One hop and no further: the node that receives this answers or refuses. */
    expect(hop.headers.get("x-scafo-proxied")).toBe("1");
    /* The peer is dialled by ADDRESS, so the name the wake was asked at travels
       as the header its host dispatch reads — `fetch` forbids setting `host`. */
    expect(hop.headers.get("x-forwarded-host")).toBe(PARKED_HOST);
    expect(hop.headers.get("host")).toBeNull();

    /* Nothing was stamped and nothing was started HERE: the node it went to
       admits it, stamps it and boots it as its own wake. */
    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.toBeNull();
    expect(loop.kicks).toBe(0);
    await expect(counters()).resolves.toEqual({
      inFlight: 0,
      admitted: 0,
      refused: 0,
      forwarded: 1,
    });
  });

  it("wakes a request a peer forwarded, under the name the forward carried", async () => {
    await placedOn(PREVIEW, [NODE_ID]);
    loop.onKick = (): void => {
      loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    };

    const response = await forwardedAsk(PARKED_HOST, "/cart");

    /* The far end of the hop above, and it needs no token: the request arrives
       on the ordinary wake surface, matched by the name it carries. */
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(UPSTREAM_BODY);
    expect(upstream.map((call) => call.url)).toEqual(["http://127.0.0.1:42004/cart"]);
    expect(upstream[0].headers.get("x-forwarded-host")).toBe(PARKED_HOST);
    expect(loop.kicks).toBe(1);
    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.toEqual(
      new Date(clock.nowMs()),
    );
    await expect(counters()).resolves.toEqual({
      inFlight: 0,
      admitted: 1,
      refused: 0,
      forwarded: 0,
    });
  });

  it("refuses a forwarded wake it was not given either, rather than passing it on", async () => {
    await placedOn(PREVIEW, [PEER]);

    const response = await forwardedAsk(PARKED_HOST, "/");

    /* The decision moved while the request was in flight. A placement being
       changed settles within a pass, so the caller is told to come back — a ring
       of nodes each convinced the next one owns it would forward forever. */
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe(String(WAKE_RETRY_AFTER_S));
    await expect(response.json()).resolves.toMatchObject({
      type: "urn:scafo:wake-unavailable",
      title: "This node was not given this environment",
    });
    expect(upstream).toEqual([]);
    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.toBeNull();
    expect(loop.kicks).toBe(0);
  });

  it("refuses when no node the placement named is live", async () => {
    await placedOn(PREVIEW, [PEER]);
    await drainNode(clock.ctx, PEER);

    const response = await ask(PARKED_HOST, "/");

    /*
     * A node on its way out is counted out here exactly as it is in placement,
     * and nothing is started here in its place: serving an environment the
     * placement put elsewhere is what placement exists to prevent, and this node
     * has the least claim of any to it.
     */
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe(String(WAKE_RETRY_AFTER_S));
    await expect(response.json()).resolves.toMatchObject({
      type: "urn:scafo:wake-unavailable",
      title: "No node that could wake this is live",
    });
    expect(upstream).toEqual([]);
    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.toBeNull();
    expect(loop.kicks).toBe(0);
    await expect(counters()).resolves.toEqual({
      inFlight: 0,
      admitted: 0,
      refused: 0,
      forwarded: 0,
    });
  });
});

describe("what a wake says about itself", () => {
  it("names every answer, whether or not this node is observing anything", async () => {
    /* ON EVERY ANSWER: it costs a few random bytes and it is what ties a
       caller's failed request, an ingress log line and the node's own events
       together. What the switch decides is whether there is anything to
       correlate WITH, never whether the request has a name. */
    app = appWith({ observability: false });
    loop.processes = [ready(PREVIEW, BUILD, 42_004)];

    const served = await ask(PARKED_HOST, "/");
    const missing = await ask(`${PROJECT}--ghost.${DOMAIN}`, "/");

    for (const [response, why] of [
      [served, "served"],
      [missing, "404"],
    ] as const) {
      expect(response.headers.get(WAKE_HEADER), why).toMatch(/^[\da-f]{12}$/);
    }
    /* Two requests, two names. */
    expect(served.headers.get(WAKE_HEADER)).not.toBe(missing.headers.get(WAKE_HEADER));
    /* And nothing was recorded, because nothing was watching. */
    expect(observe.snapshot().events).toEqual([]);
  });

  it("leaves a served wake as admitted, resolved, stamped, kicked and served", async () => {
    loop.onKick = (): void => {
      loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    };

    const response = await ask(PARKED_HOST, "/cart");
    const id = response.headers.get(WAKE_HEADER);

    /* A successful wake must leave a trace, and this is it: the seams that were
       reconstructed by hand the last time a wake had to be explained. */
    expect(observe.snapshot().events.map((event) => event.type)).toEqual([
      "wake.admitted",
      "wake.resolved",
      "wake.stamped",
      "wake.kicked",
      "wake.served",
    ]);
    /* One request, one id, on the answer and on all five. */
    expect(id).not.toBeNull();
    expect(new Set(wakeIds())).toEqual(new Set([id]));

    expect(observe.snapshot().events[0]).toMatchObject({
      type: "wake.admitted",
      host: PARKED_HOST,
      project: PROJECT,
      env: PREVIEW,
      inFlight: 1,
    });
    /* What resolving the Host and the placement cost the bucket, attributed to
       the request now that there is an admitted one to attribute it to. */
    expect(eventOf("wake.resolved")).toMatchObject({ storeOps: expect.any(Number) });
    expect((eventOf("wake.resolved") as { storeOps: number }).storeOps).toBeGreaterThan(0);
    expect(eventOf("wake.served")).toMatchObject({ port: 42_004, status: 200 });
  });

  it("records a refusal AT the cap, and records it as a refusal", async () => {
    app = appWith({ maxConcurrentWakes: 1 });
    const held = ask(PARKED_HOST, "/");
    await sleep(WAKE_POLL_INTERVAL_MS / 2);

    const refused = await ask(OTHER_PARKED_HOST, "/");

    /* The refused request never became a wake — it was turned away before
       anything was stamped — so ITS id is on this event and on no other. The
       held request's own events are beside it and are not this request's. */
    const id = refused.headers.get(WAKE_HEADER);
    expect(eventOf("wake.refused")).toMatchObject({ id, host: OTHER_PARKED_HOST });
    expect(
      observe
        .snapshot()
        .events.filter((event) => "id" in event && event.id === id)
        .map((event) => event.type),
    ).toEqual(["wake.refused"]);

    loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    await held;
  });

  it("records a wake that was not woken in time as a failure with its reason", async () => {
    await setParkPolicy(clock.ctx, PROJECT, PREVIEW, { wakeDeadlineS: 1 });

    const response = await ask(PARKED_HOST, "/");

    expect(response.status).toBe(503);
    /* The 503 is named too, so a caller who reports one can be asked which. */
    expect(response.headers.get(WAKE_HEADER)).toMatch(/^[\da-f]{12}$/);
    expect(observe.snapshot().events.map((event) => event.type)).toEqual([
      "wake.admitted",
      "wake.resolved",
      "wake.stamped",
      "wake.kicked",
      "wake.failed",
    ]);
    expect(eventOf("wake.failed")).toMatchObject({ reason: "deadline" });
  });

  it("records nothing for a wake it handed to a peer, which is that node's to record", async () => {
    await placedOn(PREVIEW, [PEER]);

    const response = await ask(PARKED_HOST, "/");

    /* Nothing was admitted, stamped or started here — and the id the caller
       gets is THIS node's, for the request it actually made, rather than the
       one the peer answered under. */
    expect(response.status).toBe(201);
    expect(response.headers.get(WAKE_HEADER)).toMatch(/^[\da-f]{12}$/);
    expect(observe.snapshot().events).toEqual([]);
  });

  it("stamps the events on the seam's own clock", async () => {
    loop.onKick = (): void => {
      loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    };

    await ask(PARKED_HOST, "/");

    /* The manual clock never moved, so every event of the request is on it
       rather than on the wall — which is what makes a timeline assertable. */
    const stamped = new Date(clock.nowMs()).toISOString();
    expect(observe.snapshot().events.map((event) => event.at)).toEqual(Array(5).fill(stamped));
  });
});

describe("GET /v1/state", () => {
  it("reports what is parked and what this node has done about wakes", async () => {
    loop.onKick = (): void => {
      loop.processes = [ready(PREVIEW, BUILD, 42_004)];
    };
    await ask(PARKED_HOST, "/");

    const response = await app.request("/v1/state", { headers: await bearer() });
    const state = (await response.json()) as DaemonState;

    /* An environment nothing runs for because it was never deployed looks
       exactly like one nothing runs for because it is waiting to be woken, and
       only one of them is answered by sending it a request. */
    expect(state.parked).toEqual([
      { project: PROJECT, env: PREVIEW },
      { project: PROJECT, env: OTHER_PREVIEW },
    ]);
    /* Node-local soft state, exactly like the deploy map: nothing here is in the
       registry, and a restarted daemon counts from zero again. */
    expect(state.wakes).toEqual({ inFlight: 0, admitted: 1, refused: 0, forwarded: 0 });
  });
});

/* ------------------------------------------------------------------ helpers */

/** One request as it arrives off the wire: the `Host` header is what decides. */
function ask(host: string, path: string): Promise<Response> {
  return Promise.resolve(app.request(path, { headers: { host } }));
}

/**
 * One request as a PEER's forward delivers it: dialled at this node's own
 * address, so `Host` names that address, with the name the wake was asked at in
 * `x-forwarded-host` and the mark that says this is already a second hop.
 */
function forwardedAsk(host: string, path: string): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      headers: {
        "host": `${SELF_ADDRESS.internal}:${String(SELF_ADDRESS.apiPort)}`,
        "x-forwarded-host": host,
        "x-scafo-proxied": "1",
      },
    }),
  );
}

/** Records the coordinator's decision about one environment, as it would. */
async function placedOn(env: string, nodes: string[]): Promise<void> {
  const write = await writePlacement(clock.ctx, PROJECT, env, nodes, lease);
  if (write.outcome !== "written") throw new Error(`the placement was ${write.outcome}`);
}

/** What this node has done about wakes, read back through its own API. */
async function counters(): Promise<WakeCounters> {
  const response = await app.request("/v1/state", { headers: await bearer() });
  return ((await response.json()) as DaemonState).wakes;
}

interface AppOptions {
  /** Concurrent wakes this node's capacity allows. Defaults to two. */
  maxConcurrentWakes?: number;
  /** Whether this node has probed its own hardware at all. */
  capacity?: boolean;
  /** Whether this node runs a reconcile loop. */
  reconciler?: boolean;
  /**
   * Address this node's runtime processes bind their listeners to, and therefore
   * the one every dialer of theirs must use. Defaults to loopback.
   */
  bindHost?: string;
  /**
   * Whether this node reports on itself. On by default, so every case runs the
   * observing path; `false` is the node that is not observing at all, which is
   * an ABSENT seam rather than a disabled one.
   */
  observability?: boolean;
  /**
   * Whether this node publishes the fleet's API at its platform apexes. On by
   * default, which is the product default; `false` is the operator who kept the
   * apex for something else, and the surface then behaves as it did before the
   * apex answered anything.
   */
  apiPublic?: boolean;
}

/** This node's app, over the shared registry, loop and upstream stand-in. */
function appWith(opts: AppOptions): H3 {
  const daemon: DaemonContext = {
    config: daemonConfig(opts.bindHost, opts.apiPublic),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    version: VERSION,
    fetchFn: stubFetch,
  };
  if (opts.observability !== false) daemon.observability = observe;
  if (opts.capacity !== false) daemon.capacity = capacityPlan(opts.maxConcurrentWakes ?? 2);
  if (opts.reconciler !== false) daemon.reconciler = loop;
  return createNodeApp(daemon);
}

/**
 * Records the hop and answers as whatever is at the other end of it would: the
 * peer's daemon when it was dialled at the peer's address, the woken process when
 * it was dialled on loopback.
 */
const stubFetch: typeof fetch = async (input, init) => {
  const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
  const body = init?.body ?? null;
  upstream.push({
    url,
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body: body === null ? null : await new Response(body).text(),
  });

  if (url.startsWith(`http://${PEER_ADDRESS.internal}:`)) {
    return new Response(PEER_BODY, {
      status: 201,
      headers: { "content-type": "text/plain", "x-served-by": PEER },
    });
  }
  return new Response(UPSTREAM_BODY, { status: 200, headers: { "content-type": "text/plain" } });
};

interface FakeReconciler extends Reconciler {
  /** Passes asked for NOW; one wake kicks exactly one. */
  kicks: number;
  /** What the loop reports as running, which a case moves by hand. */
  processes: RuntimeProcess[];
  /** What its last pass read as parked. */
  parked: ParkedEnvironment[];
  /** What a kick does to this node, for a case that brings a process up with one. */
  onKick?: () => void;
}

/** A loop that runs no pass; what it reports is whatever the case put there. */
function fakeReconciler(): FakeReconciler {
  const fake: FakeReconciler = {
    kicks: 0,
    processes: [],
    parked: [],

    runOnce: () => Promise.resolve([]),

    kick(): void {
      fake.kicks++;
      fake.onKick?.();
    },

    start: (): void => {},
    shutdown: (): Promise<void> => Promise.resolve(),
    stop: (): void => {},
    parkedRecords: (): ParkedEnvironment[] => fake.parked.map((entry) => ({ ...entry })),

    status: () => ({
      lastRunAt: null,
      running: false,
      lastActions: [],
      failures: [],
      processes: [...fake.processes],
      placements: [],
      parked: fake.parked.map((entry) => ({ project: entry.project, env: entry.env.name })),
    }),
  };
  return fake;
}

/** A supervised process a wake may be handed to. */
function ready(env: string, _build: string, port: number): RuntimeProcess {
  return {
    processId: `${PROJECT}--${env}`,
    project: PROJECT,
    env,
    configuredVarset: null,
    port,
    internalPort: port + 1,
  };
}

/**
 * Two parked environments of one project, a build each of them once served, and
 * an environment on its way out beside them.
 */
async function seed(): Promise<void> {
  await createProject(clock.ctx, { slug: PROJECT });
  for (const name of [PREVIEW, OTHER_PREVIEW, RETIRED]) {
    await createEnvironment(clock.ctx, PROJECT, { name, ephemeral: true });
  }
  for (const id of [BUILD, SUPERSEDED, THIRD]) {
    await createBuild(clock.ctx, PROJECT, {
      id,
    });
  }
  /* Recorded before builds said which fleet holds their code: not wakeable. */
  await createBuild(clock.ctx, PROJECT, { id: ORPHAN_BUILD });

  await recordDeployment(clock.ctx, PROJECT, PREVIEW, SUPERSEDED);
  await recordDeployment(clock.ctx, PROJECT, PREVIEW, BUILD);
  await recordDeployment(clock.ctx, PROJECT, OTHER_PREVIEW, BUILD);
  await recordDeployment(clock.ctx, PROJECT, RETIRED, BUILD);
  await claimDomain(clock.ctx, CUSTOM, PROJECT, PREVIEW);
  await retireEnvironment(clock.ctx, PROJECT, RETIRED);

  loop.parked = [
    { project: PROJECT, env: await getEnvironment(clock.ctx, PROJECT, PREVIEW) },
    { project: PROJECT, env: await getEnvironment(clock.ctx, PROJECT, OTHER_PREVIEW) },
  ];
}

function daemonConfig(bindHost = "127.0.0.1", apiPublic = true): DaemonConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: NODE_ID, listen: "127.0.0.1:7400" },
    platformDomains: [DOMAIN],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      bindHost,
      durability: "bucket",
      cellIdleEvictS: 900,
    },
    observability: { enabled: false },
    api: { public: apiPublic, jsonBytes: 65_536 },
  };
}

function capacityPlan(maxConcurrentWakes: number): CapacityPlan {
  return {
    cores: 4,
    memMb: 16_384,
    cgroup: false,
    threads: 4,
    isolates: 4,
    rssBudgetMb: 1400,
    maxRssMbPerProcess: 1400,
    maxResidentCells: 2000,
    maxConcurrentWakes,
    probedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Runs nothing: every process a wake finds was put there by the case. */
function idleSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: () => [],
    onExit: () => {},
  };
}

async function bearer(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await signNodeToken(keys.privateKey, NODE_ID)}` };
}

/** The first event of a type this node recorded, or undefined for none. */
function eventOf(type: ObservedEvent["type"]): ObservedEvent | undefined {
  return observe.snapshot().events.find((event) => event.type === type);
}

/** The request ids on every event that carries one, in order. */
function wakeIds(): string[] {
  return observe.snapshot().events.flatMap((event) => ("id" in event ? [event.id] : []));
}

/** The loopback ports the hops dialled, in the order they were dialled. */
function dialled(): number[] {
  return upstream.map((call) => Number(new URL(call.url).port));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
