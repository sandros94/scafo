import { ScaloError } from "../error.ts";
import type { NodeRecord } from "../types/registry.ts";
import { isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, deleteKey, readJson, requireJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { type LeaseHandle, verifyLease } from "./lease.ts";
import { nodeKey, nodesPrefix } from "./paths.ts";

/** How often a running agent refreshes its own record's `heartbeatAt`. */
export const NODE_HEARTBEAT_INTERVAL_MS: number = 30_000;

/**
 * How long a node counts as live after the last heartbeat it managed to write.
 *
 * Three intervals rather than one: two refreshes may be lost to a slow bucket
 * before a perfectly healthy node is counted out, and counting one out is what
 * moves its environments to another node.
 */
export const NODE_LIVENESS_WINDOW_MS: number = 3 * NODE_HEARTBEAT_INTERVAL_MS;

/**
 * Registers or refreshes a node: nodes re-register on every start, so the record
 * is replaced wholesale. The id addresses the record and cannot change.
 */
export async function registerNode(ctx: RegistryContext, record: NodeRecord): Promise<NodeRecord> {
  const key = nodeKey(record.id);

  try {
    await createJson(ctx, key, record);
    return record;
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    const updated = await updateJson<NodeRecord>(ctx, key, (current) => {
      if (current.id !== record.id) {
        throw new ScaloError("immutable", "Node id cannot be changed", {
          detail: `"${key}" holds node "${current.id}"`,
        });
      }
      return record;
    });
    return updated.value;
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

/**
 * Every registered node's record, in id order.
 *
 * A record that vanished between the listing and the read is left out rather
 * than raised: a node deregistering mid-pass is ordinary, and the next pass sees
 * the fleet as it then is.
 */
export async function listNodeRecords(ctx: RegistryContext): Promise<NodeRecord[]> {
  const records: NodeRecord[] = [];
  for (const id of await listNodes(ctx)) {
    const found = await readJson<NodeRecord>(ctx, nodeKey(id));
    if (found !== null) records.push(found.value);
  }
  return records;
}

/**
 * Stamps this node as still there, touching `heartbeatAt` and NOTHING else.
 *
 * Narrow on purpose: a node re-registering rewrites its record wholesale from
 * its own configuration, and a heartbeat is not the moment to restate an
 * address or a capacity. Throws `ScaloError("not-found")` when the node has no
 * record — a heartbeat cannot bring one into being, because the record says what
 * this node IS and only registration knows that.
 */
export async function heartbeatNode(ctx: RegistryContext, id: string): Promise<string> {
  const at = nowIso(ctx);
  await updateJson<NodeRecord>(ctx, nodeKey(id), (current) => ({ ...current, heartbeatAt: at }));
  return at;
}

/**
 * Whether `record` counts as live for placement: its last sign of life is newer
 * than {@link NODE_LIVENESS_WINDOW_MS}.
 *
 * `heartbeatAt` is that sign; `capacity.probedAt` stands in for a record written
 * by a node too old to refresh one, so a rolling upgrade does not read the fleet
 * as empty. A record carrying neither is NOT live: nothing in it says when the
 * node was last seen, and guessing "recently" would hand environments to a node
 * that may be years gone.
 *
 * Pure, so the caller decides what "now" is.
 */
export function isNodeLive(record: NodeRecord, now: Date, opts?: { windowMs?: number }): boolean {
  const seenAt = record.heartbeatAt ?? record.capacity?.probedAt;
  if (seenAt === undefined) return false;

  const seen = Date.parse(seenAt);
  if (!Number.isFinite(seen)) return false;
  return now.getTime() - seen < (opts?.windowMs ?? NODE_LIVENESS_WINDOW_MS);
}

/**
 * Deregisters a node. Deletes cannot be conditional, so this is gated on the
 * caller still holding the coordinator lease; otherwise `ScaloError("lease-lost")`.
 */
export async function removeNode(
  ctx: RegistryContext,
  id: string,
  lease: LeaseHandle,
): Promise<void> {
  if (!(await verifyLease(ctx, lease))) {
    throw new ScaloError("lease-lost", "Coordinator lease is no longer held", {
      detail: `refusing to remove node "${id}"`,
    });
  }
  await deleteKey(ctx, nodeKey(id));
}
