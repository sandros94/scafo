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
 * AND ACROSS THE SET THERE IS A SECOND AXIS: an operator-tier key is SCOPED to a
 * list of projects ({@link TrustedOperator.projects}), which is what a
 * multi-tenant installation hands a tenant. The scope binds the KEY on the wire
 * — the node API refuses a scoped key that names a project outside its list —
 * and it is deliberately NOT a bucket-plane control: bucket credentials are
 * root, and a multi-tenant platform hands tenants operator keys, never bucket
 * credentials.
 *
 * THE SCOPE IS NOT OPTIONAL, AND THAT IS THE WHOLE POSTURE. An operator-tier key
 * that names no projects is refused at every grant ({@link assertGrantableScope})
 * and reaches NOTHING if one was written by hand anyway
 * ({@link canReachProject}). The wave that introduced scoping made it opt-in,
 * with absent meaning every project — which meant an enrollment that simply left
 * the flag off handed out the run of the fleet, silently, and read in a listing
 * exactly like a key somebody had thought about. Least privilege cannot be the
 * thing you have to remember. So the ceiling is stated out loud instead:
 * {@link WILDCARD_PROJECT} as the sole entry is "every project", it is an
 * ADMIN's to grant fresh, and a key that carries it says so in every listing.
 *
 * ABSENT STILL MEANS EVERY PROJECT FOR AN ADMIN, because an admin is not a
 * tenant: it administers every key the fleet trusts, so it can grant itself a
 * key for anything at any time, and a scope on one would state a boundary it
 * does not have. A MACHINE of the fleet is not governed here at all — a node
 * token carries no operator record — and neither is a workload's OIDC token.
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

/**
 * The one entry a scope may hold that is not a project: EVERY project, said out
 * loud.
 *
 * It exists because "every project" has to be sayable. Once an absent scope
 * means nothing, a key that legitimately serves the whole fleet — a platform's
 * own CI, an operator who is not quite an admin — would otherwise have to be
 * enrolled with every slug listed and re-enrolled on each new project. The
 * difference from the absent scope it replaces is that this one is a STATED
 * grant: it is in the record, it is in every listing, and an admin had to write
 * it.
 *
 * IT MUST BE THE SOLE ENTRY. Mixed with slugs it would either mean "every
 * project" — making the slugs decoration — or "these projects", making the
 * wildcard decoration, and there is no reading of the pair that is not somebody
 * being surprised later. See {@link assertOperatorScope}.
 */
export const WILDCARD_PROJECT: string = "*";

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
   * Projects this key may name on a node's API, or `[{@link WILDCARD_PROJECT}]`
   * for every one of them.
   *
   * REQUIRED ON AN OPERATOR-TIER KEY and never set on an ADMIN, which is the
   * same rule read from both ends: an admin reaches every project because it
   * could grant itself any key it liked, and an operator reaches exactly what
   * somebody named. Absent therefore means opposite things at the two tiers —
   * every project above, nothing below — and both are refused at write time by
   * {@link assertOperatorScope} and {@link assertGrantableScope}. See
   * {@link canReachProject} for what a hand-written record without one reads as.
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
 * Whether `projects` is the stated grant of EVERY project rather than a list of
 * them: {@link WILDCARD_PROJECT}, alone.
 *
 * Alone is part of the question rather than a validation of it, so that a record
 * somebody wrote by hand as `["*", "acme"]` — which {@link assertOperatorScope}
 * would have refused — reads as the two literal names it holds and reaches
 * neither, instead of reading as the whole fleet.
 */
export function isWildcardScope(projects: string[] | undefined): boolean {
  return projects?.length === 1 && projects[0] === WILDCARD_PROJECT;
}

/**
 * Whether `operator` may name `project` at all.
 *
 * THE ANSWER FOR AN ABSENT SCOPE DEPENDS ON THE TIER, and this is the surface
 * that decision lives on. An ADMIN naming no projects reaches every one, because
 * an admin is not a tenant and never carries a scope. An OPERATOR-tier key
 * naming none reaches NOTHING: every path that grants one refuses to write that
 * record, so a key carrying it was written straight to the bucket by hand, and
 * reading it as "every project" is precisely the silent widening this whole
 * axis exists to prevent. It stays a trusted key — it authenticates, it can
 * rotate itself, an admin can revoke it — and it is worth nothing here until
 * somebody says what it is for.
 *
 * A key carrying {@link WILDCARD_PROJECT} alone reaches every project, as a
 * grant an admin made rather than as a default nobody chose.
 *
 * Pure, so the node API and the tests ask the same question of the same
 * function. It says nothing about the BUCKET: whoever holds the bucket's
 * credentials holds the fleet, and this is a control on operator keys.
 */
export function canReachProject(operator: TrustedOperator, project: string): boolean {
  if (operator.projects === undefined) return operator.role === "admin";
  if (isWildcardScope(operator.projects)) return true;
  return operator.projects.includes(project);
}

/**
 * Whether a caller may register a key scoped to `wanted`.
 *
 * NO WIDER THAN ONE'S OWN, which is {@link canGrantRole} one axis over and the
 * reason a scoped key cannot rotate or enrol its way out of its scope. Read as
 * sets it is one subset test and no special cases: an admin's reach is every
 * project, a wildcard key's is every project, a scoped key's is its list, and a
 * scope-LESS operator-tier key's is the empty set — so that last one may grant
 * only what it holds, which is nothing.
 *
 * `undefined` for `wanted` is the caller's own scope carried over rather than a
 * request for every project: the routes reach here with `request.projects ??
 * caller.projects`, so an absent `wanted` means the caller carried none either.
 * Whether that carry-over may be WRITTEN at all is
 * {@link assertGrantableScope}'s question, not this one — this one only ever
 * says whether it would be a widening, and carrying nothing over is not.
 */
export function canGrantScope(caller: TrustedOperator, wanted: string[] | undefined): boolean {
  if (wanted === undefined) return true;
  if (caller.role === "admin" || isWildcardScope(caller.projects)) return true;

  const own = caller.projects ?? [];
  /* A wildcard is every project, so nothing but the two universes above grants
     one — and `every` over a one-entry list would otherwise ask whether the
     caller's list happens to contain the literal "*". */
  if (isWildcardScope(wanted)) return false;
  return wanted.every((project) => own.includes(project));
}

/**
 * Checks the scope a key is about to be written WITH — what the record may say,
 * whoever is writing it and whichever way they got here.
 *
 * AN ADMIN IS NEVER SCOPED, and the refusal is the point rather than a
 * formality: an admin administers every key the fleet trusts, so it can hand
 * itself a key for any project it likes — a scope on one would read like a
 * boundary while enforcing nothing, which is worse than no boundary at all.
 *
 * A scope naming NO project is refused too, because a list is how a key says
 * what it reaches and an empty one says nothing: an operator-tier key meant to
 * reach every project says {@link WILDCARD_PROJECT}, and one meant to reach some
 * of them names those.
 *
 * AND THE WILDCARD MUST STAND ALONE. `["*", "acme"]` either means every project,
 * which makes the slug decoration, or means acme, which makes the wildcard
 * decoration — so it is refused rather than read as one of the two. That is also
 * why the wildcard is exempt from slug validation only in that position.
 *
 * Throws `ScafoError("invalid-input")` for all three, and
 * `ScafoError("invalid-slug")` for a name that is neither a project slug nor the
 * lone wildcard.
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
        `an empty list is a key that may reach nothing at all; name the projects this key is ` +
        `for, or "${WILDCARD_PROJECT}" alone for every project of this fleet`,
    });
  }
  if (isWildcardScope(projects)) return;
  if (projects.includes(WILDCARD_PROJECT)) {
    throw new ScafoError("invalid-input", "A wildcard scope stands alone", {
      detail:
        `"${WILDCARD_PROJECT}" means every project of this fleet, so listing it beside named ` +
        `projects says two different things at once; use "${WILDCARD_PROJECT}" on its own, or ` +
        `name the projects and leave it out`,
    });
  }
  for (const project of projects) assertSlug(project);
}

/**
 * Checks the scope a key is about to be GRANTED with — which is the same
 * question one step earlier, and the one an absent scope is answered by.
 *
 * AN OPERATOR-TIER KEY MUST NAME WHAT IT REACHES. Both ways a key enters a fleet
 * come through here — `POST /v1/operators` and the bucket-side ceremony — so an
 * enrollment that left the scope off is refused identically whether it was asked
 * for over the wire or with the bucket's own credentials, and no path is the
 * quiet one. The refusal exists because the alternative is a default: absent
 * once meant every project, which made the most permissive key in the fleet the
 * one nobody had thought about.
 *
 * SEPARATE FROM {@link assertOperatorScope} BECAUSE GRANTING AND CARRYING OVER
 * ARE DIFFERENT ACTS. A rotation registers a replacement for a key that already
 * exists and copies its scope across unchanged; it hands out no reach that was
 * not already out there, so it is not a grant and does not come through here.
 * That is what keeps a hand-written scope-less record repairable — its holder
 * can still rotate it, and what they end up with is worth exactly what they
 * started with — while nothing can create one.
 *
 * Bootstrap is untouched: the first key of an installation is always an admin
 * ({@link bootstrapRole}), and an admin carries no scope by rule.
 *
 * Throws `ScafoError("invalid-input")`.
 */
export function assertGrantableScope(key: Pick<TrustedOperator, "role" | "projects">): void {
  assertOperatorScope(key);
  if (key.role === "admin" || key.projects !== undefined) return;

  throw new ScafoError("invalid-input", "An operator-tier key must name its projects", {
    detail:
      `a key that names no projects would reach nothing at all, and a key meant to reach the ` +
      `whole fleet has to say so: name the projects this one is for, or "${WILDCARD_PROJECT}" ` +
      `alone for every project — which an admin of this fleet grants`,
  });
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
