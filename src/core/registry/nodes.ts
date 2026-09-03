import { ScafoError } from "../error.ts";
import type { NodeRecord, NodeServing } from "../types/registry.ts";
import { deepEqual, isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, readJson, requireJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { claimIdentity, identityReservation } from "./identity.ts";
import { nodeKey, nodesPrefix, operatorKey } from "./paths.ts";

/** How often a running daemon refreshes its own record's `heartbeatAt`. */
export const NODE_HEARTBEAT_INTERVAL_MS: number = 30_000;

/** Liveness window; allows two missed heartbeats before reassignment. */
export const NODE_LIVENESS_WINDOW_MS: number = 3 * NODE_HEARTBEAT_INTERVAL_MS;

/** Registers or refreshes a node wholesale. Durable identity reservation prevents
    node/operator id collisions and node re-keying. */
export async function registerNode(ctx: RegistryContext, record: NodeRecord): Promise<NodeRecord> {
  const key = nodeKey(record.id);
  const existing = await registerNodeIfAbsent(ctx, record);
  if (existing === null) return record;

  const updated = await updateJson<NodeRecord>(ctx, key, (current) => {
    if (current.id !== record.id) {
      throw new ScafoError("immutable", "Node id cannot be changed", {
        detail: `"${key}" holds node "${current.id}"`,
      });
    }
    return record;
  });
  return updated.value;
}

/** Claims and creates a node only when absent; compatible existing records stay unchanged. */
export async function registerNodeIfAbsent(
  ctx: RegistryContext,
  record: NodeRecord,
): Promise<NodeRecord | null> {
  const key = nodeKey(record.id);

  const existing = await readJson<NodeRecord>(ctx, key);
  if (existing !== null && !deepEqual(existing.value.publicKey, record.publicKey)) {
    throw new ScafoError("reference-held", "Id belongs to another identity of this installation", {
      detail: `"${record.id}" is already reserved by another identity; choose another id`,
    });
  }

  if ((await readJson(ctx, operatorKey(record.id))) !== null) {
    throw new ScafoError("reference-held", "Id belongs to an operator key of this installation", {
      detail:
        `"${record.id}" is a key this fleet trusts, and a machine registered under it would ` +
        `take that key's identity — every node would verify its tokens against this machine's ` +
        `public key; give the node another id, or revoke the key first`,
    });
  }

  await claimIdentity(ctx, record.id, identityReservation("node", record.publicKey));
  if (existing !== null) return existing.value;

  try {
    await createJson(ctx, key, record);
    return null;
  } catch (error) {
    if (!isCasConflict(error)) throw error;
    const winner = await requireJson<NodeRecord>(ctx, key);
    if (!deepEqual(winner.value.publicKey, record.publicKey)) {
      throw new ScafoError(
        "reference-held",
        "Id belongs to another identity of this installation",
        {
          detail: `"${record.id}" is already reserved by another identity; choose another id`,
        },
      );
    }
    return winner.value;
  }
}

export async function getNode(ctx: RegistryContext, id: string): Promise<NodeRecord> {
  const found = await requireJson<NodeRecord>(ctx, nodeKey(id));
  return found.value;
}

/** Ids of every registered node, lexicographically sorted. */
export async function listNodes(ctx: RegistryContext): Promise<string[]> {
  const prefix = nodesPrefix();
  return namesFromKeys(await ctx.store.list(prefix), prefix);
}

/** Node records in id order; records deleted after listing are omitted. */
export async function listNodeRecords(ctx: RegistryContext): Promise<NodeRecord[]> {
  const records: NodeRecord[] = [];
  for (const id of await listNodes(ctx)) {
    const found = await readJson<NodeRecord>(ctx, nodeKey(id));
    if (found !== null) records.push(found.value);
  }
  return records;
}

export interface HeartbeatInput {
  /**
   * What the node serves as of this beat, replacing what the record said. Left
   * out, the record keeps saying what it said: a beat that has not looked at the
   * node's processes has no business changing where the fleet routes.
   */
  serving?: NodeServing;
}

/**
 * Stamps `heartbeatAt`, and `serving` when the caller says what the node serves.
 * Nothing else is touched, and a heartbeat cannot create a node record.
 */
export async function heartbeatNode(
  ctx: RegistryContext,
  id: string,
  input?: HeartbeatInput,
): Promise<string> {
  const at = nowIso(ctx);
  const serving = input?.serving;
  await updateJson<NodeRecord>(ctx, nodeKey(id), (current) => ({
    ...current,
    heartbeatAt: at,
    ...(serving === undefined ? {} : { serving }),
  }));
  return at;
}

/**
 * Says this node is leaving, so placement stops counting it among the nodes it
 * hands work to. Touches `drainingAt` and NOTHING else.
 *
 * The first step of a graceful shutdown, and the whole reason one is worth
 * taking: a daemon that simply stopped would look exactly like a crash, and a
 * crash is only noticed once the liveness window has run out — a minute and a
 * half in which its environments are served by a process that is already gone.
 * A node that says it is leaving is counted out on the coordinator's very next
 * assignment pass instead.
 *
 * Throws `ScafoError("not-found")` when the node has no record, for the same
 * reason {@link heartbeatNode} does: this states something ABOUT a record, and
 * cannot bring one into being.
 */
export async function drainNode(ctx: RegistryContext, id: string): Promise<string> {
  const at = nowIso(ctx);
  await updateJson<NodeRecord>(ctx, nodeKey(id), (current) => ({ ...current, drainingAt: at }));
  return at;
}

/**
 * Whether `record` counts as live for placement: it is not draining, and its
 * last sign of life is newer than {@link NODE_LIVENESS_WINDOW_MS}.
 *
 * `heartbeatAt` is that sign. A record carrying none is NOT live: nothing in it
 * says when the node was last seen, and guessing "recently" would hand
 * environments to a node that may be years gone.
 *
 * `drainingAt` outranks all of it. A node on its way out has usually just
 * beaten — it is stopping in an orderly fashion, not failing — so judging it by
 * its heartbeat alone would keep it a placement candidate for the whole liveness
 * window after it stopped serving. Its own word about where it is going is
 * better evidence than the timestamp of the last thing it did.
 *
 * Pure, so the caller decides what "now" is.
 */
export function isNodeLive(record: NodeRecord, now: Date, opts?: { windowMs?: number }): boolean {
  if (record.drainingAt !== undefined) return false;

  const seenAt = record.heartbeatAt;
  if (seenAt === undefined) return false;

  const seen = Date.parse(seenAt);
  if (!Number.isFinite(seen)) return false;
  return now.getTime() - seen < (opts?.windowMs ?? NODE_LIVENESS_WINDOW_MS);
}
