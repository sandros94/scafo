/*
 * Waking what this node has parked: the surface that answers for a host no
 * process is serving yet.
 *
 * A request arrives here because the routing sent it here — a parked
 * environment's host, a superseded build's hash host, or any host under a
 * platform domain that nothing else claims. It is held while the reconcile loop
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
import { ScafoError } from "../core/error.ts";
import { readJson } from "../core/registry/cas.ts";
import { nowDate } from "../core/registry/context.ts";
import { isNodeLive } from "../core/registry/nodes.ts";
import { nodeKey } from "../core/registry/paths.ts";
import { readPlacement } from "../core/registry/placement.ts";
import { stampBuildWake, stampEnvironmentWake } from "../core/registry/wake.ts";
import type { NodeRecord, PlacementRecord } from "../core/types/registry.ts";
import type { RuntimeProcess } from "../core/types/runtime.ts";
import { isProxiedHop } from "./_peer.ts";
import { forwardWake, proxyToProcess } from "./_wake-proxy.ts";
import type { ParkedEnvironment } from "./_desired.ts";
import { resolveWakeTarget, type WakeTarget } from "./_wake-target.ts";
import type { AgentContext } from "./app.ts";
import { problemResponse } from "./middleware.ts";

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
 * agent counts from zero again, and two nodes of one installation each report
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

/** The agent's wake surface: which hosts belong to it, and what it answers them with. */
export interface WakeService {
  /**
   * Whether a request's Host belongs to the wake surface rather than to the
   * agent's API — any host under a platform domain, and any custom domain a
   * parked environment claims.
   *
   * A CONSEQUENCE WORTH KNOWING: an agent reached under one of its own platform
   * domains is reached as the wake surface, API path or not. That is the routing
   * being honoured rather than an accident — every host under those domains is
   * routed here — and it is why `node.listen` is loopback by default.
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
 * request only reaches the agent through routing lag — the ingress has not yet
 * been told the process is ready — and the ordinary path answers it correctly:
 * the stamp is harmless, the ready process is found on the first look, and the
 * request is proxied without ever being held.
 */
export function createWakeService(agent: AgentContext): WakeService {
  let inFlight = 0;
  let admitted = 0;
  let refused = 0;
  let forwarded = 0;

  /** What the last reconcile pass read as parked; empty on a node with no loop. */
  function parked(): ParkedEnvironment[] {
    return agent.reconciler?.parkedRecords() ?? [];
  }

  function handles(host: string): boolean {
    if (host === "") return false;

    for (const domain of agent.config.platformDomains) {
      if (host.endsWith(`.${domain}`)) return true;
    }
    return parked().some((entry) => entry.env.domains.includes(host));
  }

  /** The ready process serving the target, or undefined while there is none. */
  function servingProcess(target: WakeTarget): RuntimeProcess | undefined {
    return agent.reconciler?.status().processes.find(
      (process) =>
        process.ready &&
        process.project === target.project &&
        process.env === target.env.name &&
        /* An environment is answered by any leg it has ready; a recalled build is
           answered by the process serving THAT build and by no other. */
        (target.kind === "environment" || process.build === target.build.id),
    );
  }

  /**
   * Holds the request until something is ready to take it, or until the
   * environment's own deadline runs out. The loop is polled rather than
   * subscribed to because readiness is a fact about a process the loop already
   * re-establishes on every pass, and there is nothing here to keep in sync.
   */
  async function awaitServing(target: WakeTarget): Promise<RuntimeProcess | undefined> {
    const deadline = Date.now() + target.policy.wakeDeadlineS * 1000;
    for (;;) {
      const process = servingProcess(target);
      if (process !== undefined) return process;
      if (Date.now() >= deadline) return undefined;

      await delay(WAKE_POLL_INTERVAL_MS);
    }
  }

  /**
   * Records that this was asked for. Never swallowed: the stamp is the whole of
   * what makes the loop start anything, so a wake that cannot be written down is
   * a wake that will not happen, and holding the request until the deadline
   * would only report it thirty seconds later.
   */
  async function stamp(target: WakeTarget): Promise<void> {
    if (target.kind === "build") {
      await stampBuildWake(agent.registry, target.project, target.env.name, target.build.id);
      return;
    }
    await stampEnvironmentWake(agent.registry, target.project, target.env.name);
  }

  /**
   * The first node the placement names that is live and is not this one, or null
   * when there is none.
   *
   * FIRST rather than a choice among them: the record's order is the
   * coordinator's own, which is stable and the same on every node, so every node
   * forwarding the same environment sends it to the same peer. A wake is one
   * boot, and spreading the requests would make it several.
   *
   * A node named in the record but MISSING from the registry is skipped rather
   * than raised: a decision outlives the deregistration of a node it names by up
   * to one coordinator pass, and the next name in the record is the answer. So
   * is a draining one — {@link isNodeLive} counts it out, and a node on its way
   * out will not boot anything.
   */
  async function liveAssignedNode(nodes: string[]): Promise<NodeRecord | null> {
    const now = nowDate(agent.registry);

    for (const id of nodes) {
      if (id === agent.nodeId) continue;
      const found = await readJson<NodeRecord>(agent.registry, nodeKey(id));
      if (found !== null && isNodeLive(found.value, now)) return found.value;
    }
    return null;
  }

  /**
   * Where this wake runs, decided before anything is admitted, stamped or
   * started — the node that boots must be one the placement chose, and this is
   * the whole of what says whether that is this one.
   *
   * A MISSING PLACEMENT RECORD IS SERVED HERE, which is the same fallback the
   * reconcile loop reads it with (see `_desired.ts`): nothing has been decided,
   * so every node serves everything, and a single-node installation never leaves
   * this line.
   *
   * An environment carrying a NODE SELECTOR gets no branch of its own here, and
   * deliberately so. Nothing has been placed, so nobody is serving it — and
   * holding the request HERE under its own deadline is exactly right: the stamp
   * this writes is what the coordinator's next pass has to place, the node it
   * lands on brings it up, and this node hands over whatever it can see is ready
   * before the deadline. When that does not happen inside the deadline the
   * request gets the same `503` every wake that was not ready in time gets, and
   * the retry lands on a settled placement.
   *
   * A FORWARDED REQUEST IS NEVER FORWARDED AGAIN. Reaching a node that reads
   * itself as unassigned means the decision moved while the request was in
   * flight; that settles within a pass, so the caller is told to come back
   * rather than sent around a mesh of nodes each forwarding to the next.
   */
  async function whereItRuns(event: H3Event, target: WakeTarget, host: string): Promise<WakeRun> {
    const placement = await readPlacement(agent.registry, target.project, target.env.name);
    if (placement === null || placement.nodes.includes(agent.nodeId)) return { kind: "local" };

    if (isProxiedHop(event.req.headers)) {
      return { kind: "unavailable", response: notAssignedHere(host, agent.nodeId, placement) };
    }

    const node = await liveAssignedNode(placement.nodes);
    if (node === null) {
      return { kind: "unavailable", response: noAssignedNodeLive(host, placement) };
    }
    return { kind: "forward", node };
  }

  async function handle(event: H3Event): Promise<Response> {
    const host = requestHost(event);
    const target = await resolveWakeTarget(agent.registry, {
      host,
      platformDomains: agent.config.platformDomains,
      parked: parked(),
    });
    if (target === null) return unknownHost(host);

    const reconciler = agent.reconciler;
    if (reconciler === undefined) return noLoop(host);

    const where = await whereItRuns(event, target, host);
    if (where.kind === "unavailable") return where.response;

    const cap = agent.capacity?.maxConcurrentWakes ?? FALLBACK_MAX_CONCURRENT_WAKES;
    if (inFlight >= cap) {
      refused++;
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
          ...(agent.fetchFn === undefined ? {} : { fetchFn: agent.fetchFn }),
        });
      }

      admitted++;
      await stamp(target);
      /* Converge NOW rather than at the end of the interval: the whole of a
         wake's latency that scafo controls is the gap between the stamp and the
         pass that reads it. */
      reconciler.kick();

      const process = await awaitServing(target);
      if (process === undefined) return notInTime(host, target);

      return await proxyToProcess(event, {
        port: process.port,
        host,
        ...(agent.fetchFn === undefined ? {} : { fetchFn: agent.fetchFn }),
      });
    } finally {
      /* Always, however the request ended: a slot held by a request that failed
         is a slot the next wake never gets. */
      inFlight--;
    }
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
 * address is where a peer's agent is, so its `Host` names the address rather
 * than the name the wake was asked at; `fetch` forbids setting `host` on the way
 * out in any case. The name therefore travels in the header an ingress would
 * have used for it, and this is the one place that reads it.
 *
 * WHAT THE GUARD IS AND IS NOT WORTH. It grants no reach: anyone who can open a
 * connection to this listener can already ask for any host by setting `Host`
 * itself, which is why the agent's own `node.listen` is loopback by default and
 * why nothing on this surface is authenticated. What the guard prevents is scafo
 * DISPATCHING on a header that belongs to somebody else — an ingress in front of
 * the agent sets `x-forwarded-host` on every request it proxies, Caddy included,
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
 * It says nothing about which way that was — never deployed, retired, reaped,
 * recall turned off — and it is permanent by design rather than by omission: the
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
