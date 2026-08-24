/*
 * The operator keys a fleet trusts.
 *
 * They live among the nodes, because that is what makes them work: an agent
 * verifies a bearer token against whatever the registry holds under the token's
 * `kid`, and does not care whether that id belongs to a machine or to a person.
 * What tells the two apart is the ADDRESS — an operator names none, because
 * nothing ever connects to one — and that is the whole discriminator, so the
 * surface here is where it is read and written rather than in every caller.
 *
 * The two kinds are never administered through each other: a node is registered
 * by the machine it is, and removed by the coordinator that outlived it, while
 * an operator key is added and dropped by another operator. Crossing the two
 * would let a compromised agent write itself an operator, or let a key rotation
 * take a serving node out of the fleet.
 */

import { ScafoError } from "../error.ts";
import type { NodeRecord } from "../types/registry.ts";
import { deleteKey, readJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import { nodeKey } from "./paths.ts";
import { listNodeRecords, registerNode } from "./nodes.ts";

/**
 * What an operator record carries where a node carries a host. Nothing resolves
 * or connects to it; it is a marker, and it is the one the record is read by.
 */
export const OPERATOR_ADDRESS: string = "operator";

/** The public half of an Ed25519 operator key, as the registry files it. */
export interface OperatorPublicKey {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

/** One key a fleet trusts: the id its tokens carry, and what verifies them. */
export interface TrustedOperator {
  id: string;
  publicKey: OperatorPublicKey;
}

/**
 * Whether `record` is an operator key rather than a machine of the fleet.
 *
 * Both halves of the marker are required. A node always publishes the port its
 * agent answers on, and an operator answers on none, so a record that names
 * neither a reachable address nor a port is the only shape this surface writes.
 */
export function isOperatorRecord(record: NodeRecord): boolean {
  return record.addresses.internal === OPERATOR_ADDRESS && record.addresses.agentPort === 0;
}

/** Every operator key the fleet trusts, in id order. */
export async function listOperators(ctx: RegistryContext): Promise<TrustedOperator[]> {
  const records = await listNodeRecords(ctx);
  return records
    .filter((record) => isOperatorRecord(record))
    .map((record) => ({ id: record.id, publicKey: record.publicKey }));
}

/**
 * Records `key` as one the fleet trusts, which is what makes a node accept the
 * tokens it signs.
 *
 * IDEMPOTENT: trusting a key that is already trusted rewrites the same record,
 * so a rotation interrupted after this step and rerun costs nothing. That is
 * what lets the expand half of an expand-contract be retried blindly.
 *
 * Throws `ScafoError("reference-held")` when the id already belongs to a MACHINE
 * of this installation: replacing that record would hand the node's identity to
 * a person, and the node would be refused by every peer until it registered
 * again.
 */
export async function trustOperator(
  ctx: RegistryContext,
  key: TrustedOperator,
): Promise<TrustedOperator> {
  const existing = await readJson<NodeRecord>(ctx, nodeKey(key.id));
  if (existing !== null && !isOperatorRecord(existing.value)) {
    throw new ScafoError("reference-held", "Id belongs to a node of this installation", {
      detail:
        `"${key.id}" is registered as a node at ${existing.value.addresses.internal}, and an ` +
        `operator key filed under it would take that node's identity; choose another id`,
    });
  }

  await registerNode(ctx, {
    v: 1,
    id: key.id,
    publicKey: key.publicKey,
    addresses: { internal: OPERATOR_ADDRESS, agentPort: 0 },
  });
  return key;
}

/**
 * Stops the fleet trusting the key filed under `id`.
 *
 * THE LAST ONE IS REFUSED. A fleet trusting no operator key has nobody who can
 * put one back through a node — every route that could is itself operator-authed
 * — and the only way left in is a write straight to the bucket, which is exactly
 * the credential an operator is not expected to be carrying. Rotation never
 * meets this refusal, because it registers the new key BEFORE dropping the old:
 * there are always two at the moment one is removed.
 *
 * Throws `ScafoError("not-found")` when nothing is filed under the id,
 * `ScafoError("invalid-input")` when what is filed is a machine rather than an
 * operator, and `ScafoError("reference-held")` for the last trusted key.
 *
 * No lease is taken, unlike `removeNode`. What a lease buys there is a
 * multi-record deletion carried out by one writer at a time; this removes ONE
 * independent record, and the count it is guarded by is re-read immediately
 * before. Two operators revoking the two last keys at the same instant could
 * still empty the set, and the way back from that is the bucket-side
 * registration `scafo keygen --register` has always been.
 */
export async function revokeOperator(ctx: RegistryContext, id: string): Promise<void> {
  const found = await readJson<NodeRecord>(ctx, nodeKey(id));
  if (found === null) {
    throw new ScafoError("not-found", "No such operator key", {
      detail: `"${id}" is not a key this fleet trusts`,
    });
  }
  if (!isOperatorRecord(found.value)) {
    throw new ScafoError("invalid-input", "Id belongs to a node of this installation", {
      detail:
        `"${id}" is a node at ${found.value.addresses.internal}, not an operator key; a node ` +
        `leaves the fleet by draining, and is removed by the coordinator`,
    });
  }

  const trusted = await listOperators(ctx);
  if (trusted.length <= 1) {
    throw new ScafoError("reference-held", "This is the last trusted operator key", {
      detail:
        `"${id}" is the only operator key this fleet trusts, and a fleet that trusts none can ` +
        `be administered through no node at all; register another one first, then remove this`,
    });
  }

  await deleteKey(ctx, nodeKey(id));
}
