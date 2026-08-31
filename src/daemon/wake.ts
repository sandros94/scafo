/*
 * Waking what this node has parked: the surface that answers for a host no
 * process is serving yet.
 *
 * A request arrives here because the routing sent it here — a parked
 * environment's host, or any host under a platform domain that nothing else
 * claims. It is held while the reconcile loop
 * starts what it asked for, and handed to that process once it is ready.
 *
 * WHICH NODE STARTS IT IS THE PLACEMENT'S ANSWER RATHER THAN THE ROUTING'S.
 * Every node claims those hosts, so a wake lands wherever the request happened
 * to go; a node the placement did not give the environment to starts nothing of
 * its own and hands the still-held request to a live node that WAS given it,
 * streaming that node's answer back over the connection the caller is waiting
 * on. One hop, never two.
 */

import type { H3Event } from "h3";
import { describeError, ScafoError } from "../core/error.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { countingRegistry, storeOpsOf } from "../core/registry/counting.ts";
import { readPlacement } from "../core/registry/placement.ts";
import { stampEnvironmentWake } from "../core/registry/wake.ts";
import { servingBackend } from "../core/placement/routes.ts";
import type { NodeRecord, PlacementRecord } from "../core/types/registry.ts";
import { startBudget } from "../core/utils/budget.ts";
import { isProxiedHop, liveAssignedNodes } from "./_peer.ts";
import { forwardWake, proxyToProcess } from "./_wake-proxy.ts";
import type { ParkedEnvironment } from "./_desired.ts";
import { resolveWakeTarget, type WakeTarget } from "./_wake-target.ts";
import type { DaemonContext } from "./app.ts";
import { runtimeDialHost } from "./config.ts";
import { problemResponse } from "./middleware.ts";
import type { Reconciler } from "./reconcile.ts";

/**
 * Header every answer this surface makes carries, holding the id that request
 * was handled under.
 *
 * ON EVERY ANSWER, whether or not this node is observing anything — served,
 * held-then-503, 404, refused. It costs a few random bytes and it is what ties a
 * caller's failed request, an ingress access log and (when the node IS
 * observing) that request's own events together, which is exactly the
 * correlation that was missing when a wake had to be reconstructed after the
 * fact. What the switch decides is whether there is anything to correlate WITH,
 * never whether the request has a name.
 *
 * A FORWARDED ANSWER CARRIES THIS NODE'S ID, not the peer's: the peer's answer
 * arrives with its own, and the id a caller is given is the one for the request
 * it actually made. The peer's is in the peer's own ring, under its own hop.
 */
export const WAKE_HEADER: string = "x-scafo-wake";

/** Seconds a refused wake tells the caller to wait before asking again. */
export const WAKE_RETRY_AFTER_S: number = 5;

/** Time between two looks at what the reconcile loop reports while a request is held. */
export const WAKE_POLL_INTERVAL_MS: number = 250;

/**
 * Wakes allowed at once on a node that has never probed its own capacity. One,
 * which is the floor the capacity formula itself guarantees: a node that knows
 * nothing about its hardware wakes one thing at a time rather than guessing.
 */
export const FALLBACK_MAX_CONCURRENT_WAKES: number = 1;

/**
 * What this node has done about wakes since it booted. NODE-LOCAL SOFT STATE,
 * exactly like the deploy map: nothing here is in the registry, a restarted
 * daemon counts from zero again, and two nodes of one installation each report
 * only their own.
 */
export interface WakeCounters {
  /**
   * Requests being held right now, against the node's concurrent-wake cap. A
   * forwarded wake is held here too: the held connection is the resource the cap
   * is about, and it is held whether the boot happens here or elsewhere.
   */
  inFlight: number;
  /**
   * Wakes THIS node took on — let through the cap, stamped and kicked here —
   * whether or not they went on to be served.
   */
  admitted: number;
  /** Wakes turned away AT the cap, having started nothing and stamped nothing. */
  refused: number;
  /**
   * Wakes handed to a node the placement assigned, because this one was not
   * among them. They passed the cap and were held here, and they stamped and
   * started NOTHING here: the node they went to admits them as its own.
   *
   * Disjoint from {@link WakeCounters.admitted} on purpose — the two answer
   * different questions, "how much has this node been woken for" and "how much
   * has it been asked for on behalf of another". A refusal that never reached
   * the cap is in none of the three, exactly as a 404 is.
   */
  forwarded: number;
}

/** The daemon's wake surface: which hosts belong to it, and what it answers them with. */
export interface WakeService {
  /**
   * Whether a request's Host belongs to the wake surface rather than to the
   * node API — any host under a platform domain, and any custom domain a
   * parked environment claims.
   *
   * A CONSEQUENCE WORTH KNOWING: a node daemon reached under one of its own platform
   * domains is reached as the wake surface, API path or not. That is the routing
   * being honoured rather than an accident — every host under those domains is
   * routed here — and it is why `node.listen` is loopback by default.
   *
   * THE ONE EXCEPTION IS THE BARE APEX OF A PLATFORM DOMAIN, while `api.public`
   * is on: that name is the fleet's API and belongs to the routes rather than to
   * this surface, so a path nothing serves there is the API's own 404 problem
   * document instead of a wake refusal. It is a name no label parses to, so
   * nothing else would have claimed it — but a custom domain claimed for a
   * parked environment could, and the API wins.
   */
  handles(host: string): boolean;
  /**
   * Answers one request on that surface: a woken process — this node's, or that
   * of a node the placement gave the environment to — a `404` or a `503`.
   */
  handle(event: H3Event): Promise<Response>;
  counters(): WakeCounters;
}

/** Where one wake runs: here, on a node that was given it, or nowhere for now. */
type WakeRun =
  | { kind: "local" }
  | { kind: "forward"; node: NodeRecord }
  | { kind: "unavailable"; response: Response };

/**
 * Builds the wake surface for this node.
 *
 * THE CAP IS ON ADMISSION, NOT ON BOOTS. A wake over the cap is answered `503`
 * and writes NO stamp, so nothing is started on behalf of a request that was
 * already turned away — which is what keeps a crawler walking a platform domain
 * from turning a node into a boot farm, since the reconcile loop only ever
 * starts what a stamp asked for.
 *
 * A WAKE LANDS WHEREVER THE ROUTING PUT IT, AND THE NODE THAT BOOTS IS ONE THE
 * PLACEMENT CHOSE. Every node claims a parked environment's hosts, so any of
 * them may be asked; the one asked serves the request itself when the placement
 * gave it that environment, and otherwise forwards the request — still held,
 * still unanswered — to a live node that was given it. Nothing about the answer
 * changes: the caller waits on one connection and gets the application's own
 * response over it.
 *
 * A HOST WHOSE ENVIRONMENT IS ALREADY SERVED NEEDS NO SPECIAL CASE. Such a
 * request only reaches the daemon through routing lag — the ingress has not yet
 * been told the process is ready — and the ordinary path answers it correctly:
 * the ready process is found on the first look and the request is proxied
 * without ever being held. It records environment activity so the next pass
 * keeps that environment desired.
 */
export function createWakeService(daemon: DaemonContext): WakeService {
  let inFlight = 0;
  let admitted = 0;
  let refused = 0;
  let forwarded = 0;

  /* Where a woken process is dialled: WHAT IT BINDS, which is loopback on a
     single node and this node's tunnel address on a fleet. The same value the
     ingress routes to — dialling loopback here
     while the listeners are elsewhere does the whole of a wake and then fails
     the request it was for. */
  const upstreamHost = runtimeDialHost(daemon.config.runtime);

  /** What the last reconcile pass read as parked; empty on a node with no loop. */
  function parked(): ParkedEnvironment[] {
    return daemon.reconciler?.parkedRecords() ?? [];
  }

  function handles(host: string): boolean {
    if (host === "") return false;

    /* The fleet's API, not an application: the routing sends this name here for
       the routes below to answer, so it is dispatched to them and a path they do
       not have is their own 404 rather than a wake for a host that has none. */
    if (daemon.config.api.public && daemon.config.platformDomains.includes(host)) return false;

    for (const domain of daemon.config.platformDomains) {
      if (host.endsWith(`.${domain}`)) return true;
    }
    return parked().some((entry) => entry.env.domains.includes(host));
  }

  /**
   * The loopback port serving the target right now, or undefined while nothing
   * is.
   *
   * An environment is answered with the same current ready backend the ingress
   * renders, including the ready generation retained during in-place adoption.
   * That distinction matters while the old process overlaps its replacement.
   */
  function servingPort(target: WakeTarget): number | undefined {
    const processes = daemon.reconciler?.status().processes ?? [];

    return servingBackend(target.project, target.env, processes)?.port;
  }

  /**
   * Holds the request until something is ready to take it, or until the
   * environment's own deadline runs out. The loop is polled rather than
   * subscribed to because running state is a fact about a process the loop already
   * re-establishes on every pass, and there is nothing here to keep in sync.
   */
  async function awaitServing(target: WakeTarget): Promise<number | undefined> {
    /* How long the request is held is a duration, so it is measured
       monotonically (`utils/budget.ts`) rather than against a wall clock a step
       could take seconds off — the caller is on the other end of this one, and
       what it would get is a 503 for a wake that was still inside its deadline. */
    const remaining = startBudget(target.policy.wakeDeadlineS * 1000);
    for (;;) {
      const port = servingPort(target);
      if (port !== undefined) return port;
      if (remaining() <= 0) return undefined;

      await delay(WAKE_POLL_INTERVAL_MS);
    }
  }

  /**
   * Records a demand the desired state cannot already derive. Never swallowed:
   * the stamp is the whole of what makes a parked environment start, so a wake
   * that cannot be written down is a wake that will not happen,
   * and holding the request until the deadline would only report it thirty
   * seconds later. A running environment has received meaningful traffic too.
   */
  async function stamp(registry: RegistryContext, target: WakeTarget): Promise<void> {
    await stampEnvironmentWake(registry, target.project, target.env.name);
  }

  /**
   * Where this wake runs, decided before anything is admitted, stamped or
   * started — the node that boots must be one the placement chose, and this is
   * the whole of what says whether that is this one.
   *
   * A MISSING PLACEMENT RECORD IS HELD HERE, not served here. This node may
   * admit the wake, stamp its demand and kick its reconcile loop, but a
   * production reconcile requires the coordinator's explicit placement before
   * it starts anything. Returning `local` only chooses where the held request
   * waits; it is not permission to run the environment.
   *
   * A NODE SELECTOR needs no separate branch: missing placement means nobody is
   * serving either constrained or unconstrained work. Holding the request HERE
   * under its deadline is still right: the stamp is what the coordinator's next
   * pass places, the assigned node brings it up, and this node hands over what it
   * can see ready. If that does not happen in time, the request gets the same
   * `503` every unready wake gets and the retry lands on a settled placement.
   *
   * A FORWARDED REQUEST IS NEVER FORWARDED AGAIN. Reaching a node that reads
   * itself as unassigned means the decision moved while the request was in
   * flight; that settles within a pass, so the caller is told to come back
   * rather than sent around a mesh of nodes each forwarding to the next.
   */
  async function whereItRuns(
    registry: RegistryContext,
    event: H3Event,
    target: WakeTarget,
    host: string,
  ): Promise<WakeRun> {
    const placement = await readPlacement(registry, target.project, target.env.name);
    if (placement === null || placement.nodes.includes(daemon.nodeId)) return { kind: "local" };

    if (isProxiedHop(event.req.headers)) {
      return { kind: "unavailable", response: notAssignedHere(host, daemon.nodeId, placement) };
    }

    /* The FIRST of them, and the iteration stops there — so every node
       forwarding the same environment sends it to the same peer, and a wake
       costs one node read rather than one per node the decision names. A wake is
       one boot, and spreading the requests would make it several. */
    for await (const node of liveAssignedNodes(registry, placement.nodes, daemon.nodeId)) {
      return { kind: "forward", node };
    }
    return { kind: "unavailable", response: noAssignedNodeLive(host, placement) };
  }

  /**
   * The answer itself, under the id the request is being handled as. Every path
   * out of here returns a Response rather than raising, which is what lets
   * {@link WAKE_HEADER} be stamped on all of them in one place.
   */
  async function answer(event: H3Event, id: string): Promise<Response> {
    const observe = daemon.observability;
    const host = requestHost(event);

    /*
     * Counted per REQUEST rather than per node, and only while observing: these
     * counters are monotonic and a shared wrapper would read every other
     * request's reads into this one's. Off, the ordinary registry is used and
     * nothing is wrapped at all.
     */
    const counted = observe === undefined ? undefined : countingRegistry(daemon.registry);
    const registry = counted?.registry ?? daemon.registry;

    const target = await resolveWakeTarget(registry, {
      host,
      platformDomains: daemon.config.platformDomains,
      parked: parked(),
    });
    if (target === null) return unknownHost(host);

    const reconciler = daemon.reconciler;
    if (reconciler === undefined) return noLoop(host);

    const where = await whereItRuns(registry, event, target, host);
    if (where.kind === "unavailable") return where.response;

    const cap = daemon.capacity?.maxConcurrentWakes ?? FALLBACK_MAX_CONCURRENT_WAKES;
    if (inFlight >= cap) {
      refused++;
      observe?.emit({ type: "wake.refused", id, host });
      return overCapacity(host, cap);
    }

    inFlight++;
    try {
      if (where.kind === "forward") {
        forwarded++;
        /* NO stamp and NO kick: the request is not this node's to answer, and
           starting anything here would be this node serving an environment the
           placement took away from it. The node it goes to admits it, stamps it
           and boots it as its own wake. */
        return await forwardWake(event, {
          node: where.node,
          host,
          ...(daemon.fetchFn === undefined ? {} : { fetchFn: daemon.fetchFn }),
        });
      }

      admitted++;
      if (observe !== undefined) {
        observe.emit({
          type: "wake.admitted",
          id,
          host,
          project: target.project,
          env: target.env.name,
          inFlight,
        });
        /* What resolving the Host and the placement cost, attributed to the
           request now that there is an admitted one to attribute it to. */
        observe.emit({
          type: "wake.resolved",
          id,
          ...(counted === undefined ? {} : { storeOps: storeOpsOf(counted.counts()) }),
        });
      }

      return await served(event, { id, host, target, registry, reconciler });
    } catch (error) {
      observe?.emit({ type: "wake.failed", id, reason: describeError(error) });
      throw error;
    } finally {
      /* Always, however the request ended: a slot held by a request that failed
         is a slot the next wake never gets. */
      inFlight--;
    }
  }

  /** The admitted path: stamp, kick, hold, and hand the request to the process. */
  async function served(
    event: H3Event,
    opts: {
      id: string;
      host: string;
      target: WakeTarget;
      registry: RegistryContext;
      reconciler: Reconciler;
    },
  ): Promise<Response> {
    const observe = daemon.observability;
    const { id, host, target } = opts;

    await stamp(opts.registry, target);
    /* Emitted where the PUT came back rather than where its timestamp was taken:
       what a wake waits on is the stamp being in the bucket, and the gap between
       the two is a store's, not this node's. */
    observe?.emit({ type: "wake.stamped", id });

    /* Converge NOW rather than at the end of the interval: the whole of a
       wake's latency that scafo controls is the gap between the stamp and the
       pass that reads it. */
    opts.reconciler.kick();
    observe?.emit({ type: "wake.kicked", id });

    const port = await awaitServing(target);
    if (port === undefined) {
      observe?.emit({ type: "wake.failed", id, reason: "deadline" });
      return notInTime(host, target);
    }

    const response = await proxyToProcess(event, {
      port,
      host,
      upstreamHost,
      ...(daemon.fetchFn === undefined ? {} : { fetchFn: daemon.fetchFn }),
    });
    /* The application answered, and a successful wake leaves this trace and no
       other — including WHAT it answered, since a wake that ends in a 502 from
       the process it woke is not one that worked. */
    observe?.emit({ type: "wake.served", id, port, status: response.status });
    return response;
  }

  async function handle(event: H3Event): Promise<Response> {
    const id = newWakeId();
    const response = await answer(event, id);
    /* On every answer this surface makes, whatever it is: see {@link WAKE_HEADER}. */
    response.headers.set(WAKE_HEADER, id);
    return response;
  }

  return {
    handles,
    handle,
    counters: (): WakeCounters => ({ inFlight, admitted, refused, forwarded }),
  };
}

/**
 * The `Host` a request names, lowercased and without its port. Empty when it
 * names none, which is not a host this node answers for.
 *
 * The header is what a request off the wire carries and is therefore what
 * decides; the request URL's own host stands in for it only when there is no
 * header at all, which is a request built in this process rather than received.
 * On a served request the two hold the same value, because the URL is built
 * from the header.
 *
 * ONE EXCEPTION, AND IT IS AS NARROW AS IT LOOKS: a request another node of this
 * installation forwarded here — one carrying the loop-guard header — is read
 * from `x-forwarded-host` instead. That hop is dialled by ADDRESS, because an
 * address is where a peer's daemon is, so its `Host` names the address rather
 * than the name the wake was asked at; `fetch` forbids setting `host` on the way
 * out in any case. The name therefore travels in the header an ingress would
 * have used for it, and this is the one place that reads it.
 *
 * WHAT THE GUARD IS AND IS NOT WORTH. It grants no reach: anyone who can open a
 * connection to this listener can already ask for any host by setting `Host`
 * itself, which is why the daemon's own `node.listen` is loopback by default and
 * why nothing on this surface is authenticated. What the guard prevents is scafo
 * DISPATCHING on a header that belongs to somebody else — an ingress in front of
 * the daemon sets `x-forwarded-host` on every request it proxies, Caddy included,
 * and honouring it unconditionally would let that ingress decide which surface
 * answers a request it never meant to send here.
 */
export function requestHost(event: H3Event): string {
  const named = forwardedHost(event) ?? event.req.headers.get("host") ?? event.url.host;
  return named.trim().toLowerCase().replace(/:\d+$/, "");
}

/**
 * The name a peer's forward says the request was asked at, or null when this is
 * not a forward from a peer.
 *
 * The FIRST entry when there are several: an intermediary appends to this header
 * rather than replacing it, and the name that was originally asked for is the
 * one at the front.
 */
function forwardedHost(event: H3Event): string | null {
  if (!isProxiedHop(event.req.headers)) return null;

  const named = event.req.headers.get("x-forwarded-host");
  if (named === null) return null;

  const first = named.split(",")[0].trim();
  return first === "" ? null : first;
}

/**
 * A name this installation has nothing to serve at, and the ONE answer every way
 * of getting there shares.
 *
 * It says nothing about which way that was — never deployed, retired or reaped —
 * and it is permanent by design rather than by omission: the
 * bucket is the source of truth, and a record deleted from it does not come back.
 */
function unknownHost(host: string): Response {
  /* No `Retry-After`: this is not a wait, it is an answer. */
  return refusal(
    new ScafoError("not-found", "Nothing is served at this host", {
      detail: `"${host}" names nothing this installation serves`,
    }),
  );
}

function overCapacity(host: string, cap: number): Response {
  return refusal(
    new ScafoError("wake-unavailable", "This node is already waking as much as it can", {
      detail:
        `"${host}" is parked and this node is holding its ${String(cap)} concurrent wakes, ` +
        `which is what its capacity allows; nothing was started for this request`,
    }),
    WAKE_RETRY_AFTER_S,
  );
}

function noLoop(host: string): Response {
  return refusal(
    new ScafoError("wake-unavailable", "This node cannot wake anything", {
      detail:
        `"${host}" is parked and this node runs no reconcile loop, so nothing here will ` +
        `start it`,
    }),
    WAKE_RETRY_AFTER_S,
  );
}

/**
 * A wake a peer forwarded here, to a node that reads itself as not being one of
 * the ones the placement named either.
 *
 * The decision moved between the hop being chosen and this node reading it, and
 * a placement mid-change settles within one coordinator pass — so this is a
 * wait, and the caller's retry lands on the node that now holds the environment.
 * Passing it on instead is the one thing this must not do: a ring of nodes each
 * convinced the next one owns it would forward the request forever.
 */
function notAssignedHere(host: string, nodeId: string, placement: PlacementRecord): Response {
  return refusal(
    new ScafoError("wake-unavailable", "This node was not given this environment", {
      detail:
        `"${host}" was forwarded here by another node, and node "${nodeId}" is not among the ` +
        `ones its placement names (${placement.nodes.join(", ")}); a decision that is being ` +
        `changed settles within a pass, so asking again is what this waits for`,
    }),
    WAKE_RETRY_AFTER_S,
  );
}

/**
 * A wake for an environment this node was not given, and none of the nodes that
 * WERE given it is live enough to hand it to.
 *
 * Nothing is started here in its place: serving an environment the placement put
 * elsewhere is exactly what placement exists to prevent, and it would be done on
 * the node with the least claim to it. The coordinator moves the environment to
 * a live node on its next pass, which is what the retry waits for.
 */
function noAssignedNodeLive(host: string, placement: PlacementRecord): Response {
  return refusal(
    new ScafoError("wake-unavailable", "No node that could wake this is live", {
      detail:
        `"${host}" is placed on ${placement.nodes.join(", ")}, and none of them is a live node ` +
        `this one can hand the request to; the coordinator gives the environment to a live ` +
        `node on its next pass, so asking again is what this waits for`,
    }),
    WAKE_RETRY_AFTER_S,
  );
}

function notInTime(host: string, target: WakeTarget): Response {
  return refusal(
    new ScafoError("wake-unavailable", "Not woken in time", {
      detail:
        `"${host}" was asked for and is being started, but no process was serving it after ` +
        `${String(target.policy.wakeDeadlineS)}s; it keeps starting, so asking again is what ` +
        `this waits for`,
    }),
    WAKE_RETRY_AFTER_S,
  );
}

/**
 * Every refusal the wake surface makes, rendered exactly as the API routes
 * render theirs — the same problem document, from the same code — plus, for the
 * ones that are a wait rather than an answer, the `Retry-After` saying so.
 */
function refusal(error: ScafoError, retryAfterS?: number): Response {
  return problemResponse(
    error.toProblem(),
    retryAfterS === undefined ? undefined : { "retry-after": String(retryAfterS) },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The name one request on this surface is handled under: 48 random bits, hex.
 *
 * Short because it is READ — off a response header, out of an access log, beside
 * a node's own events — and unique enough for that: it distinguishes the
 * requests one node held in one window, which is the only place it is ever
 * compared. It is not an identifier of anything that outlives the request.
 */
function newWakeId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(6))) {
    id += byte.toString(16).padStart(2, "0");
  }
  return id;
}
