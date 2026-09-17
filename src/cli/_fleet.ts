/*
 * Internal: the statements an admin makes about the installation itself — right
 * now, the deploy freeze — and how each of them prints.
 *
 * NODE-ONLY, like project administration and for the same reason: freezing is an
 * admin-tier act, and a bucket fallback would be a way around the authorization
 * the node enforces. `scafo fleet nodes` reads the bucket directly because it is
 * the one question a node cannot be trusted to answer about itself; this is the
 * opposite, and goes through a node on an operator key.
 */

import type { FreezeRecord } from "../core/types/registry.ts";
import { type NodeOptions, nodeRequest } from "./_node.ts";

/** What a node answers `POST /v1/fleet/freeze` with. */
export interface FreezeSet {
  freeze: FreezeRecord;
  /** False when deploys were already frozen, and the first freeze came back. */
  created: boolean;
}

/** The fleet surface of one node, signed for by one key. */
export interface FleetApi {
  /** Where these calls go, for whatever reports what was done and to whom. */
  via: string;
  /** Stops deploy intake fleet-wide; answers the freeze that stands. */
  freeze(reason?: string): Promise<FreezeSet>;
  /** Lifts the freeze; answers whether there was one to lift. */
  unfreeze(): Promise<boolean>;
}

export function fleetApi(opts: NodeOptions): FleetApi {
  const at = `${opts.url}/v1/fleet/freeze`;
  const call = (method: string): { method: string; fetchFn?: typeof fetch } => ({
    method,
    ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  });

  return {
    via: opts.url,

    async freeze(reason): Promise<FreezeSet> {
      /* No reason is no body at all, rather than an object saying nothing. */
      const body =
        reason === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ reason }),
            };
      const answer = await nodeRequest(at, await opts.authorize(), { ...call("POST"), ...body });
      return (await answer.json()) as FreezeSet;
    },

    async unfreeze(): Promise<boolean> {
      const answer = await nodeRequest(at, await opts.authorize(), call("DELETE"));
      return ((await answer.json()) as { lifted: boolean }).lifted;
    },
  };
}

/**
 * What `scafo fleet freeze` prints.
 *
 * THE WAY BACK OUT IS PRINTED WITH THE NEWS, and so is the code every refused
 * deploy will carry: whoever runs this is about to be asked by a colleague why
 * their pipeline stopped, and the answer to both halves of that question belongs
 * on the line they are already reading.
 */
export function describeFreeze(set: FreezeSet): string {
  return (
    `scafo: deploys ${set.created ? "are frozen" : "were already frozen"} since ` +
    `${set.freeze.frozenAt} by "${set.freeze.by}"${reasonClause(set.freeze)} — every deploy is ` +
    `refused with deploys-frozen until "scafo fleet unfreeze"`
  );
}

/** What `scafo fleet unfreeze` prints. */
export function describeUnfreeze(lifted: boolean): string {
  return lifted
    ? `scafo: deploys are no longer frozen; nodes accept them again`
    : `scafo: deploys were not frozen`;
}

/**
 * The one line `scafo fleet nodes` prints under its header while a freeze
 * stands. Said there because an operator looking at the fleet during a
 * maintenance is looking at exactly the thing the freeze was set for.
 */
export function describeFreezeLine(freeze: FreezeRecord): string {
  return `deploys: frozen since ${freeze.frozenAt} by "${freeze.by}"${reasonClause(freeze)}`;
}

/* ---------------------------------------------------------------- internals */

function reasonClause(freeze: FreezeRecord): string {
  return freeze.reason === undefined ? "" : `: ${freeze.reason}`;
}
