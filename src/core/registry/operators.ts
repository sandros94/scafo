/* Trusted operator records and tier/scope authorization. Bucket credentials
   remain fleet-root authority; operator scope applies only to node API calls. */

import { ScafoError } from "../error.ts";
import type { NodeRecord, OperatorRecord, OperatorRole } from "../types/registry.ts";
import { assertSlug } from "../utils/slug.ts";
import { deepEqual, isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, deleteKey, readJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import { claimIdentity, identityReservation } from "./identity.ts";
import { nodeKey, operatorKey, operatorsPrefix } from "./paths.ts";

export type { OperatorRecord, OperatorRole };

/** Legacy role-less records remain admin to avoid silent demotion. */
export const LEGACY_OPERATOR_ROLE: OperatorRole = "admin";

/** The tier a key lands at when nobody says otherwise: the least privilege there is. */
export const DEFAULT_OPERATOR_ROLE: OperatorRole = "operator";

/** Explicit all-application grant. It must be the scope's sole entry. */
export const WILDCARD_APPLICATION: string = "*";

/**
 * A prefix glob: a non-empty run of slug characters, which may end in a hyphen,
 * followed by one trailing `*`. `shop-*` reaches `shop-preview` and not `shop`.
 */
const PREFIX_GLOB_RE = /^[a-z\d][a-z\d-]*\*$/;

/** The public half of an Ed25519 operator key, as the registry files it. */
export interface OperatorPublicKey {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

/** One key a fleet trusts: the id its tokens carry, what verifies them, and what it may do. */
export interface TrustedOperator {
  id: string;
  publicKey: OperatorPublicKey;
  /** What it may do to the trusted set. Always present here; see {@link readOperator}. */
  role: OperatorRole;
  /** Key it was registered to replace, when a rotation registered it. */
  supersedes?: string;
  /** Application scope. Omitted means all applications for admin, none for operator. */
  applications?: string[];
}

/** Resolves legacy role defaults without widening an explicitly stored scope. */
export function readOperator(record: OperatorRecord): TrustedOperator {
  return {
    id: record.id,
    publicKey: record.publicKey,
    role: record.role ?? LEGACY_OPERATOR_ROLE,
    ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }),
    ...(record.applications === undefined ? {} : { applications: [...record.applications] }),
  };
}

/** Lists trusted keys by id. Records removed during listing are skipped. */
export async function listOperators(ctx: RegistryContext): Promise<TrustedOperator[]> {
  const prefix = operatorsPrefix();
  const keys = await ctx.store.list(prefix);

  const trusted: TrustedOperator[] = [];
  for (const id of namesFromKeys(keys, prefix)) {
    const found = await readJson<OperatorRecord>(ctx, operatorKey(id));
    if (found !== null) trusted.push(readOperator(found.value));
  }
  return trusted;
}

/**
 * The key filed under `id`, or null when nothing is.
 *
 * It never reads the machines' keyspace, and never has to: an id belongs to one
 * identity, so nothing filed under `nodes/` could be an answer to this question.
 */
export async function getOperator(
  ctx: RegistryContext,
  id: string,
): Promise<TrustedOperator | null> {
  const found = await readJson<OperatorRecord>(ctx, operatorKey(id));
  return found === null ? null : readOperator(found.value);
}

/** Admin may grant both roles; operator may grant only operator. */
export function canGrantRole(caller: OperatorRole, wanted: OperatorRole): boolean {
  return caller === "admin" || wanted === "operator";
}

/** Admin may revoke any key; operator may revoke only its predecessor. */
export function canRevoke(caller: TrustedOperator, targetId: string): boolean {
  return caller.role === "admin" || caller.supersedes === targetId;
}

/** True only for the valid sole-entry wildcard scope. */
export function isWildcardScope(applications: string[] | undefined): boolean {
  return applications?.length === 1 && applications[0] === WILDCARD_APPLICATION;
}

/** The prefix a glob entry covers, or null when the entry is an exact name. */
function globPrefix(entry: string): string | null {
  return PREFIX_GLOB_RE.test(entry) ? entry.slice(0, -1) : null;
}

/** Returns application reachability. Scope-less operator records reach nothing. */
export function canReachApplication(operator: TrustedOperator, name: string): boolean {
  if (operator.applications === undefined) return operator.role === "admin";
  if (isWildcardScope(operator.applications)) return true;

  return operator.applications.some((entry) => {
    const prefix = globPrefix(entry);
    return prefix === null ? entry === name : name.startsWith(prefix);
  });
}

/**
 * Whether a requested scope is no wider than the caller's reach.
 *
 * An entry is covered when the caller holds `*`, the identical entry, or a
 * prefix glob whose prefix the entry — an exact name or another glob's prefix —
 * starts with. `shop-*` therefore grants `shop-preview` and `shop-pre*`, and
 * never `shop` or `shop*`.
 */
export function canGrantScope(caller: TrustedOperator, wanted: string[] | undefined): boolean {
  if (wanted === undefined) return true;
  if (caller.role === "admin" || isWildcardScope(caller.applications)) return true;

  const own = caller.applications ?? [];
  /* Only admin and wildcard-scoped callers may grant wildcard scope. */
  if (isWildcardScope(wanted)) return false;

  return wanted.every((entry) => {
    const reach = globPrefix(entry) ?? entry;
    return own.some((held) => {
      const prefix = globPrefix(held);
      return prefix === null ? held === entry : reach.startsWith(prefix);
    });
  });
}

/** Validates scopes: admins unscoped, nonempty operator scope, wildcard alone. */
export function assertOperatorScope(key: Pick<TrustedOperator, "role" | "applications">): void {
  const applications = key.applications;
  if (applications === undefined) return;

  if (key.role === "admin") {
    throw new ScafoError("invalid-input", "An admin cannot be scoped to applications", {
      detail:
        `an admin administers every key this fleet trusts, so it can grant itself a key for ` +
        `any application at any time — a scope on one would state a boundary it does not have; ` +
        `register it as an operator-tier key to scope it, or as an admin with no scope`,
    });
  }
  if (applications.length === 0) {
    throw new ScafoError("invalid-input", "A scope must name an application", {
      detail:
        `an empty list is a key that may reach nothing at all; name the applications this key ` +
        `is for, or "${WILDCARD_APPLICATION}" alone for every application of this fleet`,
    });
  }
  if (isWildcardScope(applications)) return;
  if (applications.includes(WILDCARD_APPLICATION)) {
    throw new ScafoError("invalid-input", "A wildcard scope stands alone", {
      detail:
        `"${WILDCARD_APPLICATION}" means every application of this fleet, so listing it beside ` +
        `named applications says two different things at once; use ` +
        `"${WILDCARD_APPLICATION}" on its own, or name the applications and leave it out`,
    });
  }
  for (const entry of applications) {
    if (globPrefix(entry) !== null) continue;
    if (entry.includes(WILDCARD_APPLICATION)) {
      throw new ScafoError("invalid-input", "Invalid scope entry", {
        detail:
          `"${entry}" is neither an application name nor a prefix glob; a glob is a run of ` +
          `name characters, which may end in a hyphen, followed by one trailing ` +
          `"${WILDCARD_APPLICATION}" — as in "shop-*", which reaches "shop-preview" and not ` +
          `"shop"`,
      });
    }
    assertSlug(entry);
  }
}

/** Validates a new grant. Operator keys must state nonempty application reach. */
export function assertGrantableScope(key: Pick<TrustedOperator, "role" | "applications">): void {
  assertOperatorScope(key);
  if (key.role === "admin" || key.applications !== undefined) return;

  throw new ScafoError("invalid-input", "An operator-tier key must name its applications", {
    detail:
      `a key that names no applications would reach nothing at all, and a key meant to reach ` +
      `the whole fleet has to say so: name the applications this one is for, or ` +
      `"${WILDCARD_APPLICATION}" alone for every application — which an admin of this fleet ` +
      `grants`,
  });
}

/** Resolves bucket-registration role. The first key must be admin; later keys
 * default to operator. */
export async function bootstrapRole(
  ctx: RegistryContext,
  wanted?: OperatorRole,
): Promise<OperatorRole> {
  const hasAdmin = (await listOperators(ctx)).some((entry) => entry.role === "admin");
  if (hasAdmin) return wanted ?? DEFAULT_OPERATOR_ROLE;

  if (wanted === "operator") {
    throw new ScafoError("invalid-input", "A fleet cannot start without an admin", {
      detail:
        `this installation trusts no admin key yet, and an operator-tier key may neither add ` +
        `one nor revoke one — the fleet could then only be administered by writing to the ` +
        `bucket by hand; register this key as an admin and add operator-tier keys through it`,
    });
  }
  return "admin";
}

/** Trusts an operator key. Exact retries are idempotent; changed identities and
 * node-id collisions are refused without disclosing node details. */
export async function trustOperator(
  ctx: RegistryContext,
  key: TrustedOperator,
): Promise<TrustedOperator> {
  assertOperatorScope(key);

  const record: OperatorRecord = operatorRecord(key);
  const machine = await readJson<NodeRecord>(ctx, nodeKey(key.id));
  if (machine !== null) {
    throw new ScafoError("reference-held", "Id belongs to a machine of this installation", {
      detail:
        `"${key.id}" is already a machine of this fleet, and an operator key filed under it ` +
        `would take that machine's identity; choose another id`,
    });
  }

  const current = await readJson<OperatorRecord>(ctx, operatorKey(key.id));
  if (current !== null) {
    await claimIdentity(ctx, key.id, identityReservation("operator", current.value.publicKey));
    if (deepEqual(readOperator(current.value), key)) return key;
    throw identityHeld(key.id);
  }

  await claimIdentity(ctx, key.id, identityReservation("operator", record.publicKey));
  try {
    await createJson(ctx, operatorKey(key.id), record);
    return key;
  } catch (error) {
    if (!isCasConflict(error)) throw error;
  }

  const raced = await readJson<OperatorRecord>(ctx, operatorKey(key.id));
  if (raced !== null && deepEqual(readOperator(raced.value), key)) return key;
  throw identityHeld(key.id);
}

/** Revokes an operator key while preserving at least one trusted key and admin.
 * Node ids are indistinguishable from absent operator ids. */
export async function revokeOperator(ctx: RegistryContext, id: string): Promise<TrustedOperator> {
  const found = await readJson<OperatorRecord>(ctx, operatorKey(id));
  if (found === null) {
    throw new ScafoError("not-found", "No such operator key", {
      detail: `"${id}" is not a key this fleet trusts`,
    });
  }

  const removed = readOperator(found.value);
  const trusted = await listOperators(ctx);
  if (trusted.length <= 1) {
    throw new ScafoError("reference-held", "This is the last trusted operator key", {
      detail:
        `"${id}" is the only operator key this fleet trusts, and a fleet that trusts none can ` +
        `be administered through no node at all; register another one first, then remove this`,
    });
  }
  if (removed.role === "admin" && trusted.filter((key) => key.role === "admin").length <= 1) {
    throw new ScafoError("reference-held", "This is the last admin key", {
      detail:
        `"${id}" is the only admin key this fleet trusts; removing it would leave nothing able ` +
        `to add or revoke a key here, whatever else stays trusted — register another admin ` +
        `first, then remove this`,
    });
  }

  await deleteKey(ctx, operatorKey(id));
  return removed;
}

function operatorRecord(key: TrustedOperator): OperatorRecord {
  return {
    v: 1,
    id: key.id,
    publicKey: key.publicKey,
    role: key.role,
    ...(key.supersedes === undefined ? {} : { supersedes: key.supersedes }),
    ...(key.applications === undefined ? {} : { applications: [...key.applications] }),
  };
}

function identityHeld(id: string): ScafoError {
  return new ScafoError("reference-held", "Id belongs to another identity of this installation", {
    detail: `"${id}" is already reserved by another identity; choose another id`,
  });
}
