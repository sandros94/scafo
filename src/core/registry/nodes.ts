import { ScafoError } from "../error.ts";
import type { NodeRecord } from "../types/registry.ts";
import { deepEqual, isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, deleteKey, readJson, requireJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { claimIdentity, identityReservation } from "./identity.ts";
import { type LeaseHandle, verifyLease } from "./lease.ts";
import { nodeKey, nodesPrefix, operatorKey } from "./paths.ts";

/** How often a running daemon refreshes its own record's `heartbeatAt`. */
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
 *
 * Replacing it wholesale is also what un-drains a node: a record left behind by
 * a graceful shutdown carries `drainingAt`, and the boot that overwrites it puts
 * the node back in service. A node that has started is a node that serves.
 *
 * ONE ID IS ONE IDENTITY, and this is the second of the two sides it is enforced
 * from ({@link trustOperator} is the other). The durable reservation claims the
 * id before this mutable record is written, so a machine cannot replace an
 * operator or re-key a registered node. Refused with `ScafoError("reference-held")`.
 *
 * THE WORDING IS FREE HERE and the check costs one read on a path taken once per
 * boot. This is the BUCKET PLANE: whoever reaches it holds the bucket's own
 * credentials, and could write either record by hand — so there is nothing to
 * withhold from them, unlike the operator-facing side of the same invariant,
 * which says only that the id is taken.
 */
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

/**
 * Claims and creates a node only when it is absent. An existing compatible
 * record is returned unchanged, so a narrow caller can update only its field
 * without racing a daemon's wholesale registration.
 */
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
 * address or a capacity. Throws `ScafoError("not-found")` when the node has no
 * record — a heartbeat cannot bring one into being, because the record says what
 * this node IS and only registration knows that.
 */
export async function heartbeatNode(ctx: RegistryContext, id: string): Promise<string> {
  const at = nowIso(ctx);
  await updateJson<NodeRecord>(ctx, nodeKey(id), (current) => ({ ...current, heartbeatAt: at }));
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
 * `heartbeatAt` is that sign; `capacity.probedAt` stands in for a record written
 * by a node too old to refresh one, so a rolling upgrade does not read the fleet
 * as empty. A record carrying neither is NOT live: nothing in it says when the
 * node was last seen, and guessing "recently" would hand environments to a node
 * that may be years gone.
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

  const seenAt = record.heartbeatAt ?? record.capacity?.probedAt;
  if (seenAt === undefined) return false;

  const seen = Date.parse(seenAt);
  if (!Number.isFinite(seen)) return false;
  return now.getTime() - seen < (opts?.windowMs ?? NODE_LIVENESS_WINDOW_MS);
}

/**
 * Deregisters a node. Deletes cannot be conditional, so this is gated on the
 * caller still holding the coordinator lease; otherwise `ScafoError("lease-lost")`.
 */
export async function removeNode(
  ctx: RegistryContext,
  id: string,
  lease: LeaseHandle,
): Promise<void> {
  if (!(await verifyLease(ctx, lease))) {
    throw new ScafoError("lease-lost", "Coordinator lease is no longer held", {
      detail: `refusing to remove node "${id}"`,
    });
  }
  await deleteKey(ctx, nodeKey(id));
}
