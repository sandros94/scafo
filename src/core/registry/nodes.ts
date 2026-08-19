import { ScaloError } from "../error.ts";
import type { NodeRecord } from "../types/registry.ts";
import { isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, deleteKey, requireJson, updateJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import { type LeaseHandle, verifyLease } from "./lease.ts";
import { nodeKey, nodesPrefix } from "./paths.ts";

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
