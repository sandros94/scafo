/*
 * Internal: the keys a fleet trusts, as calls to one of its nodes.
 *
 * The bucket is the other way to the same records — it is how an installation is
 * bootstrapped, and how one whose operator keys have all been lost is recovered
 * — but administering them goes through a node on purpose: the credential it
 * needs is a key the fleet already trusts, and nothing else. An operator who had
 * to hold the bucket's access key to change their own would be carrying the
 * credential that makes the whole exercise unnecessary.
 */

import { ScafoError } from "../core/error.ts";
import type { TrustedOperator } from "../core/registry/operators.ts";
import { assertNodeId } from "../core/registry/paths.ts";
import {
  type AgentCallOptions,
  type AgentOptions,
  agentBaseUrl,
  agentRequest,
  operatorSigner,
} from "./_agent.ts";
import { type FleetEntry, getFleet, readFleetKey } from "./_fleets.ts";

export type { TrustedOperator };

/** What every command about a fleet's keys needs beyond the fleet itself. */
export interface FleetKeyOptions {
  /** Node to reach, when something names one other than the fleet's first endpoint. */
  agentUrl?: string;
  /** How the calls are made; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

/** What an operator can do to the set of keys a fleet trusts. */
export interface OperatorApi {
  /** How the operator is acting, as a command's own output names it. */
  readonly via: string;
  /** Every key the fleet trusts, in id order. */
  list(): Promise<TrustedOperator[]>;
  /** Records a public half. Repeating it is a no-op, not a failure. */
  trust(key: TrustedOperator): Promise<TrustedOperator>;
  /** Stops the fleet trusting `id`; answers the id that went. */
  revoke(id: string): Promise<string>;
}

/** A revocation as it happened. */
export interface RevokedKey {
  fleet: string;
  removed: string;
}

/** What a fleet trusts, and which of it this home holds. */
export interface FleetKeys {
  fleet: string;
  /** Id this home signs for the fleet with. */
  own: string;
  trusted: TrustedOperator[];
}

/** The trusted-key surface of one node, signed for by one key. */
export function operatorApi(opts: AgentOptions): OperatorApi {
  const at = (suffix: string = ""): string => `${opts.url}/v1/operators${suffix}`;
  const call = (method: string): { method: string; fetchFn?: typeof fetch } => ({
    method,
    ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  });

  return {
    via: opts.url,

    async list(): Promise<TrustedOperator[]> {
      const answer = await agentRequestJson(at(), opts, call("GET"));
      return (answer as { operators: TrustedOperator[] }).operators;
    },

    async trust(key): Promise<TrustedOperator> {
      const answer = await agentRequestJson(at(), opts, {
        ...call("POST"),
        headers: { "content-type": "application/json" },
        /* The public half alone leaves here. A node has no use for the private
           one, and a registry every node of the fleet reads is the last place
           it would belong. */
        body: JSON.stringify({ id: key.id, publicKey: key.publicKey }),
      });
      return (answer as { operator: TrustedOperator }).operator;
    },

    async revoke(id): Promise<string> {
      /* Validated rather than escaped: an id is held to the charset a bucket key
         is, so one that passes carries no separator and no traversal. One that
         does not is a mistake worth naming here, before a node answers 404 to a
         path the operator cannot see anything wrong with. */
      assertNodeId(id);
      const answer = await agentRequestJson(at(`/${id}`), opts, call("DELETE"));
      return (answer as { removed: string }).removed;
    },
  };
}

/** Where a fleet is reached, and how the call is made. */
export function fleetConnection(
  entry: FleetEntry,
  name: string,
  opts: FleetKeyOptions,
): Omit<AgentOptions, "authorize"> {
  const url = opts.agentUrl ?? entry.endpoints[0];
  if (url === undefined || url === "") {
    throw new ScafoError("invalid-input", "Fleet has no endpoint", {
      detail:
        `nothing could reach "${name}": its entry names no node agent, so give --agent <url> ` +
        `of one of them`,
    });
  }
  return {
    url: agentBaseUrl(url),
    ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  };
}

/** The trusted-key surface of a fleet, signed for by the key this home holds. */
export async function reachFleet(
  home: string,
  name: string,
  opts: FleetKeyOptions,
): Promise<OperatorApi> {
  const entry = await getFleet(home, name);
  const key = await readFleetKey(home, entry);
  return operatorApi({ ...fleetConnection(entry, name, opts), authorize: operatorSigner(key) });
}

/**
 * Stops a fleet trusting one key, signed for by the key this home holds.
 *
 * For the multi-operator case — a fleet several people administer — and for the
 * leftovers of a rotation that was interrupted after its flip. A fleet REFUSES
 * to revoke the key the request was signed with, because that removal is the one
 * nothing could verify afterwards; replacing one's own key is `scafo fleet
 * rotate` and never this.
 */
export async function revokeFleetKey(
  home: string,
  name: string,
  id: string,
  opts: FleetKeyOptions = {},
): Promise<RevokedKey> {
  const api = await reachFleet(home, name, opts);
  return { fleet: name, removed: await api.revoke(id) };
}

/** Every key the fleet trusts, and the one this home speaks with. */
export async function listFleetKeys(
  home: string,
  name: string,
  opts: FleetKeyOptions = {},
): Promise<FleetKeys> {
  const entry = await getFleet(home, name);
  const key = await readFleetKey(home, entry);
  const api = operatorApi({
    ...fleetConnection(entry, name, opts),
    authorize: operatorSigner(key),
  });

  return { fleet: name, own: key.id, trusted: await api.list() };
}

/** How a revocation reads on the terminal, revocation bound included. */
export function describeRevocation(revoked: RevokedKey): string {
  return (
    `scafo: fleet "${revoked.fleet}" no longer trusts "${revoked.removed}"; a node that has ` +
    `already read that key goes on accepting it for up to a minute, which is how long ` +
    `revocation takes to reach the whole installation`
  );
}

/** The keys a fleet trusts, as an operator reads them. */
export function formatFleetKeys(keys: FleetKeys): string {
  const lines = [
    `scafo: fleet "${keys.fleet}" trusts ${String(keys.trusted.length)} operator ` +
      `key${keys.trusted.length === 1 ? "" : "s"}`,
  ];
  for (const key of keys.trusted) {
    lines.push(`  ${key.id}${key.id === keys.own ? "  (this home signs with it)" : ""}`);
  }
  return lines.join("\n");
}

/* ---------------------------------------------------------------- internals */

/** One call, one fresh token — a spent one is refused as a replay — read as JSON. */
async function agentRequestJson(
  url: string,
  opts: AgentOptions,
  init: AgentCallOptions,
): Promise<unknown> {
  const answer = await agentRequest(url, await opts.authorize(), init);
  return answer.json();
}
