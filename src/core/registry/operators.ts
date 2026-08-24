/*
 * The operator keys a fleet trusts.
 *
 * They live among the nodes, because that is what makes them work: a node daemon
 * verifies a bearer token against whatever the registry holds under the token's
 * `kid`, and does not care whether that id belongs to a machine or to a person.
 * What tells the two apart is the ADDRESS — an operator names none, because
 * nothing ever connects to one — and that is the whole discriminator, so the
 * surface here is where it is read and written rather than in every caller.
 *
 * The two kinds are never administered through each other: a node is registered
 * by the machine it is, and removed by the coordinator that outlived it, while
 * an operator key is added and dropped by another operator. Crossing the two
 * would let a compromised daemon write itself an operator, or let a key rotation
 * take a serving node out of the fleet.
 *
 * THE TRUST MODEL, IN ONE PARAGRAPH. The BUCKET is the root anchor: whoever
 * holds its credentials holds the fleet, because every record here is a write
 * they could make by hand. Keys enter the trusted set two ways and no others —
 * the bucket-side ceremony (`scafo operator keygen --register`, `scafo operator
 * enroll` with the bucket flags, `scafo remote add --register`), which is how an
 * installation is bootstrapped and how one whose keys are all lost is recovered,
 * or an ADMIN adding one through a node. Within
 * the set there are two tiers ({@link OperatorRole}): an admin administers every
 * key the fleet trusts, while an operator-tier key may add keys no higher than
 * itself and may revoke only the key it was registered to replace. That split is
 * what this file is for. Before it, every trusted key was equal — a single
 * compromised deploy key could revoke every other operator and own the
 * installation — and the fix is verb separation rather than a second credential.
 *
 * AND ACROSS THE SET THERE IS A SECOND AXIS: an operator-tier key may be SCOPED
 * to a list of projects ({@link TrustedOperator.projects}), which is what a
 * multi-tenant installation hands a tenant. It is opt-in and absent means every
 * project, so a solo installation and every fleet older than this wave carry no
 * list and notice nothing. The scope binds the KEY on the wire — the node API
 * refuses a scoped key that names a project outside its list — and it is
 * deliberately NOT a bucket-plane control: bucket credentials are root, and a
 * multi-tenant platform hands tenants operator keys, never bucket credentials.
 */

import { ScafoError } from "../error.ts";
import type { NodeRecord, OperatorRole } from "../types/registry.ts";
import { assertSlug } from "../utils/slug.ts";
import { deleteKey, readJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import { nodeKey } from "./paths.ts";
import { listNodeRecords, registerNode } from "./nodes.ts";

export type { OperatorRole };

/**
 * What an operator record carries where a node carries a host. Nothing resolves
 * or connects to it; it is a marker, and it is the one the record is read by.
 */
export const OPERATOR_ADDRESS: string = "operator";

/**
 * The tier a record carrying none reads as.
 *
 * COMPAT, AND IT IS DELIBERATELY THE HIGH ONE. Every key an installation trusted
 * before roles existed is full-power today, so reading a role-less record as an
 * operator-tier key would silently demote every operator of every fleet that
 * upgrades — locking people out of their own installations at the moment they
 * needed to do something about it. A demotion must be an explicit act; a read is
 * never allowed to be an upgrade surprise in either direction.
 */
export const LEGACY_OPERATOR_ROLE: OperatorRole = "admin";

/** The tier a key lands at when nobody says otherwise: the least privilege there is. */
export const DEFAULT_OPERATOR_ROLE: OperatorRole = "operator";

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
  /**
   * Projects this key may name on a node's API.
   *
   * ABSENT IS EVERY PROJECT and is the ordinary shape; see
   * {@link canReachProject}. Never set on an admin — {@link assertOperatorScope}
   * refuses that combination at write time.
   */
  projects?: string[];
}

/**
 * Whether `record` is an operator key rather than a machine of the fleet.
 *
 * Both halves of the marker are required. A node always publishes the port its
 * daemon answers on, and an operator answers on none, so a record that names
 * neither a reachable address nor a port is the only shape this surface writes.
 */
export function isOperatorRecord(record: NodeRecord): boolean {
  return record.addresses.internal === OPERATOR_ADDRESS && record.addresses.apiPort === 0;
}

/**
 * One operator record as the key it describes, its tier resolved.
 *
 * The ONE place a role is read out of a record, so the compat default lives here
 * and nowhere else: a record carrying none reads as {@link LEGACY_OPERATOR_ROLE}.
 *
 * THE SCOPE IS READ AS IT STANDS, whatever the tier says. {@link trustOperator}
 * refuses a scoped admin, so a record carrying both was written straight to the
 * bucket by hand — and reading it as scoped rather than dropping the list is the
 * safe direction to be wrong in: a key that reaches less than intended is a
 * refusal somebody fixes, and one that reaches more is the thing scoping exists
 * to prevent.
 */
export function readOperator(record: NodeRecord): TrustedOperator {
  const operator = record.operator;
  return {
    id: record.id,
    publicKey: record.publicKey,
    role: operator?.role ?? LEGACY_OPERATOR_ROLE,
    ...(operator?.supersedes === undefined ? {} : { supersedes: operator.supersedes }),
    ...(operator?.projects === undefined ? {} : { projects: [...operator.projects] }),
  };
}

/** Every operator key the fleet trusts, in id order. */
export async function listOperators(ctx: RegistryContext): Promise<TrustedOperator[]> {
  const records = await listNodeRecords(ctx);
  return records.filter((record) => isOperatorRecord(record)).map((record) => readOperator(record));
}

/**
 * The key filed under `id`, or null when nothing is — or when what is filed is a
 * MACHINE of this installation rather than an operator.
 *
 * Null for both misses on purpose: a caller asking what an operator may do has
 * no use for a node's record, and answering one would invite the crossing this
 * file exists to prevent.
 */
export async function getOperator(
  ctx: RegistryContext,
  id: string,
): Promise<TrustedOperator | null> {
  const found = await readJson<NodeRecord>(ctx, nodeKey(id));
  if (found === null || !isOperatorRecord(found.value)) return null;
  return readOperator(found.value);
}

/**
 * Whether a caller of `caller` tier may register a key at `wanted`.
 *
 * NO HIGHER THAN ONE'S OWN, which is the whole rule and the reason a stolen
 * operator-tier key cannot make itself an administrator by way of a second key.
 * Pure, so the routes and the tests ask the same question of the same function.
 */
export function canGrantRole(caller: OperatorRole, wanted: OperatorRole): boolean {
  return caller === "admin" || wanted === "operator";
}

/**
 * Whether `caller` may stop the fleet trusting `targetId`.
 *
 * An admin may revoke anyone; anyone else may revoke ONLY the key their own
 * record supersedes. That second clause is what keeps rotation working below the
 * admin tier — the expand half registers the replacement with `supersedes` set,
 * and the contract half is authorized by it — while leaving an operator-tier key
 * unable to touch an admin or an unrelated colleague.
 *
 * Self-revocation is a separate refusal and is NOT decided here: it is about
 * what can be verified afterwards rather than about what a tier may do.
 */
export function canRevoke(caller: TrustedOperator, targetId: string): boolean {
  return caller.role === "admin" || caller.supersedes === targetId;
}

/**
 * Whether `operator` may name `project` at all.
 *
 * A key carrying no scope reaches every project, which is what every key of
 * every installation older than this wave carries and what a solo operator will
 * always carry. A scoped key reaches the projects it names and no others.
 *
 * Pure, so the node API and the tests ask the same question of the same
 * function. It says nothing about the BUCKET: whoever holds the bucket's
 * credentials holds the fleet, and this is a control on operator keys.
 */
export function canReachProject(operator: TrustedOperator, project: string): boolean {
  return operator.projects === undefined || operator.projects.includes(project);
}

/**
 * Whether a caller may register a key scoped to `wanted` — `undefined` being a
 * request for every project.
 *
 * NO WIDER THAN ONE'S OWN, which is {@link canGrantRole} one axis over and the
 * reason a scoped key cannot rotate or enrol its way out of its scope. An
 * unscoped caller may hand out anything, including another unscoped key, which
 * is exactly what an admin does today.
 */
export function canGrantScope(caller: TrustedOperator, wanted: string[] | undefined): boolean {
  const own = caller.projects;
  if (own === undefined) return true;
  if (wanted === undefined) return false;
  return wanted.every((project) => own.includes(project));
}

/**
 * Checks the scope a key is about to be written with.
 *
 * AN ADMIN IS NEVER SCOPED, and the refusal is the point rather than a
 * formality: an admin administers every key the fleet trusts, so it can hand
 * itself a key for any project it likes — a scope on one would read like a
 * boundary while enforcing nothing, which is worse than no boundary at all.
 *
 * A scope naming NO project is refused too. It is a key that can do nothing, and
 * the way to say "every project" is to name none at all rather than an empty
 * list — the two spellings would otherwise mean opposite things.
 *
 * Throws `ScafoError("invalid-input")` for both, and `ScafoError("invalid-slug")`
 * for a name that is not a project slug.
 */
export function assertOperatorScope(key: Pick<TrustedOperator, "role" | "projects">): void {
  const projects = key.projects;
  if (projects === undefined) return;

  if (key.role === "admin") {
    throw new ScafoError("invalid-input", "An admin cannot be scoped to projects", {
      detail:
        `an admin administers every key this fleet trusts, so it can grant itself a key for ` +
        `any project at any time — a scope on one would state a boundary it does not have; ` +
        `register it as an operator-tier key to scope it, or as an admin with no scope`,
    });
  }
  if (projects.length === 0) {
    throw new ScafoError("invalid-input", "A scope must name a project", {
      detail:
        `an empty list is a key that may reach nothing at all; a key meant to reach EVERY ` +
        `project names no projects rather than an empty list of them`,
    });
  }
  for (const project of projects) assertSlug(project);
}

/**
 * The tier a BUCKET-SIDE registration lands at, given what the operator asked
 * for.
 *
 * A FLEET MUST NEVER EXIST WITH ZERO ADMINS, and this is where that is decided,
 * because the bucket ceremony is the only way a key enters a fleet that has no
 * admin to add one. So the first key of an installation is an admin whatever
 * else is convenient, an explicit `--role operator` for it is REFUSED rather
 * than quietly promoted — the operator asked for something that cannot be
 * administered afterwards, and silently doing the opposite is worse than saying
 * so — and every key after it is least privilege unless an admin is asked for.
 *
 * Throws `ScafoError("invalid-input")` for that refusal.
 */
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

/**
 * Records `key` as one the fleet trusts, which is what makes a node accept the
 * tokens it signs.
 *
 * IDEMPOTENT: trusting a key that is already trusted rewrites the same record,
 * so a rotation interrupted after this step and rerun costs nothing. That is
 * what lets the expand half of an expand-contract be retried blindly.
 *
 * THE TIER IS THE CALLER'S TO DECIDE and is required here, because this surface
 * writes what it is told and never guesses: the two places a key is granted from
 * — the bucket ceremony ({@link bootstrapRole}) and `POST /v1/operators` — have
 * different rules, and a default living here would quietly be one of them.
 *
 * THE SCOPE IS CHECKED HERE, by {@link assertOperatorScope}, so both ways a key
 * enters a fleet meet the same rule: a scoped admin is a contradiction and is
 * refused whether it was asked for over the wire or through the bucket ceremony.
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
  assertOperatorScope(key);

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
    addresses: { internal: OPERATOR_ADDRESS, apiPort: 0 },
    operator: {
      role: key.role,
      ...(key.supersedes === undefined ? {} : { supersedes: key.supersedes }),
      ...(key.projects === undefined ? {} : { projects: [...key.projects] }),
    },
  });
  return key;
}

/**
 * Stops the fleet trusting the key filed under `id`, and answers the key that
 * went — tier included, because that is what an audit line records and it cannot
 * be read back afterwards.
 *
 * THE LAST ONE IS REFUSED. A fleet trusting no operator key has nobody who can
 * put one back through a node — every route that could is itself operator-authed
 * — and the only way left in is a write straight to the bucket, which is exactly
 * the credential an operator is not expected to be carrying. Rotation never
 * meets this refusal, because it registers the new key BEFORE dropping the old:
 * there are always two at the moment one is removed.
 *
 * AND SO IS THE LAST ADMIN, which is the same refusal one tier up. A fleet whose
 * remaining keys are all operator-tier trusts plenty of keys and can still be
 * deployed from — but no caller is allowed to grant an admin, and none is
 * allowed to revoke anything but its own lineage, so the set can never be
 * administered through a node again. Counting keys is not enough to see that;
 * counting ADMINS is.
 *
 * Throws `ScafoError("not-found")` when nothing is filed under the id,
 * `ScafoError("invalid-input")` when what is filed is a machine rather than an
 * operator, and `ScafoError("reference-held")` for the last trusted key and for
 * the last admin.
 *
 * No lease is taken, unlike `removeNode`. What a lease buys there is a
 * multi-record deletion carried out by one writer at a time; this removes ONE
 * independent record, and the counts it is guarded by are re-read immediately
 * before. Two operators revoking the two last keys at the same instant could
 * still empty the set, and the way back from that is the bucket-side
 * registration `scafo operator keygen --register` has always been.
 */
export async function revokeOperator(ctx: RegistryContext, id: string): Promise<TrustedOperator> {
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

  await deleteKey(ctx, nodeKey(id));
  return removed;
}
