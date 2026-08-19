/* The agent's HTTP API: what a node exposes to its peers and to operators. */

import { H3 } from "h3";
import { createNodeVerifier } from "../core/auth/node-token.ts";
import { readJson } from "../core/registry/cas.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { coordinatorKey, nodeKey } from "../core/registry/paths.ts";
import type { CapacityPlan } from "../core/capacity/compute.ts";
import type { CoordinatorLease, NodeRecord } from "../core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../core/types/supervisor.ts";
import type { AgentConfig } from "./config.ts";
import { renderProblem, requireNodeToken } from "./middleware.ts";
import type { Reconciler, ReconcileStatus } from "./reconcile.ts";

/** Everything the HTTP layer serves from; assembled once while the node boots. */
export interface AgentContext {
  config: AgentConfig;
  registry: RegistryContext;
  supervisor: Supervisor;
  /** Build of the agent, reported by `GET /v1/health`. */
  version: string;
  /** Opens the environments' sealed varsets; without it they start unconfigured. */
  varsetKey?: CryptoKey;
  /** What this node probed about its own hardware; bounds the processes it starts. */
  capacity?: CapacityPlan;
  /** The reconcile loop, when this node runs one. */
  reconciler?: Reconciler;
}

/** Body of `GET /v1/health`. */
export interface AgentHealth {
  ok: boolean;
  version: string;
  node: string;
}

/** Body of `GET /v1/state`: what this node believes about itself right now. */
export interface AgentState {
  /** This node's registry record; null until it has registered. */
  node: NodeRecord | null;
  /** Holder of the coordinator lease, whoever it is; null when nobody holds one. */
  lease: CoordinatorLease | null;
  processes: ProcessStatus[];
  /** Last pass of the reconcile loop; absent on a node that runs no loop. */
  reconcile?: ReconcileStatus;
}

/**
 * Builds the agent app. Every route answers failures as RFC 9457 problem
 * documents, and every route but health requires a node or operator token.
 */
export function createAgentApp(agent: AgentContext): H3 {
  /* One verifier for the whole app, never one per request: it caches the public
     keys it reads from the registry and remembers the id of every token already
     spent, and single-use tokens only stay single-use while that cache is shared. */
  const authenticated = requireNodeToken(createNodeVerifier(agent.registry));

  const app = new H3({
    /* The problem renderer decides what is worth logging, so the framework's own
       console output would only duplicate it. */
    silent: true,
    onError: renderProblem,
  });

  /*
   * Unauthenticated on purpose: an ingress or an init system has to be able to
   * poll it without holding a key.
   *
   * TODO: report the node's draining state here once shutdown is implemented, so
   * traffic stops being routed to a node on its way out.
   */
  app.get("/v1/health", (): AgentHealth => ({
    ok: true,
    version: agent.version,
    node: agent.config.node.id,
  }));

  app.get(
    "/v1/state",
    async (): Promise<AgentState> => {
      const [node, lease] = await Promise.all([
        readJson<NodeRecord>(agent.registry, nodeKey(agent.config.node.id)),
        readJson<CoordinatorLease>(agent.registry, coordinatorKey()),
      ]);
      const reconcile = agent.reconciler?.status();
      return {
        node: node?.value ?? null,
        lease: lease?.value ?? null,
        processes: agent.supervisor.list(),
        ...(reconcile === undefined ? {} : { reconcile }),
      };
    },
    { middleware: [authenticated] },
  );

  return app;
}
