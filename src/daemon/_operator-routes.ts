/*
 * Internal: the `/v1/operators` routes — the keys a fleet trusts, administered
 * through a node rather than through the bucket.
 *
 * Bucket-side registration came first and stays: an installation is bootstrapped
 * before there is a node daemon to bootstrap it through, and a fleet whose keys
 * have all been lost is recovered the same way. What these routes add is the
 * case where an operator has a WORKING key and wants a different one — a
 * rotation — which needs no bucket credential at all, because the key being
 * replaced is what authorizes replacing it.
 *
 * Every route here is operator-authed. See `requireOperatorToken`.
 *
 * AND EVERY ROUTE HERE IS ALSO ROLE-AUTHED, which is the part worth reading. A
 * trusted key is not a trusted key: an ADMIN administers the whole set, while an
 * operator-tier key may add keys no higher than itself and may revoke only the
 * key it was registered to replace. The rules live in `registry/operators.ts`
 * (`canGrantRole`, `canRevoke`) so this file is only about turning them into
 * status codes, and the refusal is `auth-scope` — the caller has proved which
 * key it holds, so what is left to say is that the key is not enough.
 */

import type { H3, H3Event, Middleware } from "h3";
import { ScafoError } from "../core/error.ts";
import {
  assertGrantableScope,
  canGrantRole,
  canGrantScope,
  canRevoke,
  DEFAULT_OPERATOR_ROLE,
  isWildcardScope,
  listOperators,
  type OperatorRole,
  revokeOperator,
  type TrustedOperator,
  trustOperator,
  WILDCARD_PROJECT,
} from "../core/registry/operators.ts";
import type { DaemonContext } from "./app.ts";
import { nodeIdentity, operatorIdentity } from "./middleware.ts";

/** Where the trusted-key surface lives. */
export const OPERATORS_PATH: string = "/v1/operators";

/** What a registration asks for, over and above the key itself. */
interface TrustRequest {
  key: Omit<TrustedOperator, "role" | "projects">;
  /** Tier the caller named, or undefined to take the surface's default. */
  role?: OperatorRole;
  /**
   * Projects the caller asked to scope the key to, or undefined to take the
   * caller's own scope — which an admin has none of, so an admin enrolling an
   * operator-tier key has to name one.
   */
  projects?: string[];
}

/** Body of `GET /v1/operators`: the keys the fleet trusts that the caller may see, in id order. */
export interface OperatorsResult {
  operators: TrustedOperator[];
  /**
   * Present, and always `true`, exactly when the listing was FILTERED to the
   * caller's own lineage rather than being the whole trusted set.
   *
   * A marker rather than a silence, because the two answers are the same shape
   * and mean very different things: a client that read a lineage listing as the
   * fleet's would conclude a fleet of five tenants trusts one key. Absent for an
   * admin, which is the only caller handed everything.
   */
  scoped?: true;
}

/** Body of `POST /v1/operators`: the key as the fleet now holds it. */
export interface OperatorTrusted {
  operator: TrustedOperator;
}

/** Body of `DELETE /v1/operators/:id`: the id that is no longer trusted. */
export interface OperatorRevoked {
  removed: string;
}

/** Adds the trusted-key routes to `app`, each behind `guard`. */
export function registerOperatorRoutes(app: H3, daemon: DaemonContext, guard: Middleware): void {
  const guarded = { middleware: [guard] };

  /*
   * The read-back half of a rotation: an operator that has just registered a key
   * asks this WITH THAT KEY, which proves the registration landed and that the
   * fleet accepts what it signs — both, in one call, before anything local is
   * repointed at it.
   *
   * BOTH TIERS MAY READ IT, and they have to: that confirm step is the middle of
   * an operator-tier rotation. What they read is not the same, though.
   *
   * AN OPERATOR-TIER CALLER SEES ITS OWN LINEAGE AND NOTHING ELSE — its record,
   * the key it was registered to replace, and any successor registered to
   * replace IT. That is exactly the set rotation needs and exactly the set the
   * tier rules let it act on: it may revoke only what it supersedes, so every
   * other key in the fleet is a name it can do nothing with. What the full
   * listing gave it instead was a directory of the installation: every other
   * tenant's key id, and every one of their PROJECTS, to anyone holding any
   * trusted key. On a multi-tenant fleet that is the tenant list, and handing it
   * over undoes the reason a tenant is given an operator key rather than a
   * bucket credential.
   *
   * THE ADMINS ARE HIDDEN TOO, which is the part that looks like an omission and
   * is not. An admin is the one key worth stealing on a fleet, and a listing
   * that pointed at them turns "I have a deploy key" into "I know which three
   * people to phish". Nothing is lost that the caller could have used: it may
   * not grant an admin tier or revoke an admin key either way. The refusals that
   * used to send callers here say "ask an admin of this fleet" instead, because
   * whoever enrolled the key is who knows.
   *
   * NOTHING IN EITHER ANSWER IS A SECRET IN ITSELF — the private halves live
   * nowhere near the registry — so this is about ENUMERATION rather than about
   * key material.
   */
  app.get(
    OPERATORS_PATH,
    async (event): Promise<OperatorsResult> => {
      const caller = requireCaller(event);
      const operators = await listOperators(daemon.registry);
      if (caller.role === "admin") return { operators };

      return { operators: operators.filter((key) => inLineageOf(caller, key)), scoped: true };
    },
    guarded,
  );

  /*
   * NO HIGHER THAN THE CALLER'S OWN TIER, and least privilege when nobody says
   * otherwise: a key registered without a role is an operator-tier key, so an
   * extra deploy key is never quietly a second administrator.
   *
   * A registration that SUPERSEDES the caller is the one exception to that
   * default, and it is what makes rotation work at either tier: a replacement
   * inherits the tier of what it replaces, which is by definition the caller's
   * own and therefore never an escalation. The lineage must name the CALLER — a
   * key claiming to supersede somebody else would be a key authorized to revoke
   * somebody else, which is exactly the escalation the tiers exist to close.
   *
   * Idempotent, because the expand half of an expand-contract must be safe to
   * repeat: a rotation interrupted anywhere before its flip is rerun from the
   * beginning, and re-registering the key it had already registered is how that
   * rerun costs nothing.
   */
  app.post(
    OPERATORS_PATH,
    async (event): Promise<OperatorTrusted> => {
      const caller = requireCaller(event);
      const request = await readTrustRequest(event);
      const supersedes = request.key.supersedes;

      if (supersedes !== undefined && supersedes !== caller.id) {
        throw new ScafoError("auth-scope", "A key may only supersede the caller's own", {
          detail:
            `this request is signed with "${caller.id}" and asks to register a key superseding ` +
            `"${supersedes}"; a key that supersedes another is authorized to revoke it, so only ` +
            `the holder of a key may register its replacement`,
        });
      }

      const role = request.role ?? (supersedes === undefined ? DEFAULT_OPERATOR_ROLE : caller.role);
      if (!canGrantRole(caller.role, role)) {
        throw new ScafoError("auth-scope", "Beyond this operator's tier", {
          detail:
            `"${caller.id}" is an ${caller.role}-tier key and cannot register an ${role}-tier ` +
            `one; an admin of this fleet can — ask whoever enrolled your key`,
        });
      }

      /*
       * THE SCOPE DEFAULTS TO THE CALLER'S OWN, which is the role rule one axis
       * over and covers both registrations an operator-tier key can make. A
       * rotation inherits the scope exactly as it inherits the tier, so a
       * rotation is never a widening; and a key registered BESIDE the caller
       * inherits it too, so an omitted `projects` is not the way out of a scope.
       */
      const projects = request.projects ?? caller.projects;
      if (!canGrantScope(caller, projects)) {
        throw new ScafoError("auth-scope", "Beyond this key's projects", {
          detail:
            `"${caller.id}" is scoped to the projects it was enrolled for, and cannot register ` +
            `a key that reaches past them; an admin of this fleet can`,
        });
      }

      /*
       * A ROTATION CARRIES A SCOPE OVER; ANYTHING ELSE GRANTS ONE. The two are
       * held to different rules because they are different acts: a replacement
       * for the caller's own key puts no reach into the fleet that was not
       * already there, while a key registered beside the caller adds one.
       *
       * So the grant rules below apply to the second and not the first. That is
       * what lets the holder of a scope-less operator-tier record — which
       * nothing grants any more, and which reaches nothing — still rotate it,
       * ending up with a key worth exactly what they started with; and it is
       * what lets a wildcard key rotate itself without being able to mint a
       * second wildcard key beside itself.
       */
      if (supersedes !== caller.id) assertFreshGrant(caller, { role, projects });

      const operator = await trustOperator(daemon.registry, {
        ...request.key,
        role,
        ...(projects === undefined ? {} : { projects }),
      });
      daemon.observability?.emit({
        type: "operator.trusted",
        actor: caller.id,
        subject: operator.id,
        role: operator.role,
      });
      return { operator };
    },
    guarded,
  );

  /*
   * AN ADMIN, OR THE KEY'S OWN SUCCESSOR, AND NOBODY ELSE. An admin administers
   * the whole set; anyone else may remove only the key their own record
   * supersedes, which is the contract half of their own rotation and nothing
   * more. So a stolen operator-tier key can lock nobody out: not an admin, and
   * not an unrelated colleague.
   *
   * REFUSES THE CALLER'S OWN KEY, first and whatever the tier. Self-revocation
   * is refused rather than supported because it cannot be verified afterwards —
   * the operator would be proving the fleet still works with a key it has just
   * thrown away. Rotation is the same act in the safe order: register the
   * replacement, prove it, and only then drop this one.
   *
   * The registry's own guards stand underneath: the last trusted key, and the
   * last ADMIN, are refused there for the bucket-side path too, which has no
   * caller to compare against.
   */
  app.delete(
    `${OPERATORS_PATH}/:id`,
    async (event): Promise<OperatorRevoked> => {
      const id = event.context.params?.id ?? "";
      const caller = requireCaller(event);

      if (id === caller.id) {
        throw new ScafoError("invalid-input", "An operator cannot revoke its own key", {
          detail:
            `"${id}" is the key this request was signed with; replace it with ` +
            `"scafo operator rotate", which registers the new key and proves it before this one ` +
            `is dropped, or have another operator revoke it`,
        });
      }
      if (!canRevoke(caller, id)) {
        throw new ScafoError("auth-scope", "Beyond this operator's tier", {
          detail:
            `"${caller.id}" is an ${caller.role}-tier key: it may revoke only the key it was ` +
            `registered to replace, which "${id}" is not; an admin of this fleet can revoke it ` +
            `— ask whoever enrolled your key`,
        });
      }

      const removed = await revokeOperator(daemon.registry, id);
      daemon.observability?.emit({
        type: "operator.revoked",
        actor: caller.id,
        subject: removed.id,
        role: removed.role,
      });
      return { removed: id };
    },
    guarded,
  );
}

/* ---------------------------------------------------------------- internals */

/**
 * Whether `key` is part of `caller`'s own rotation chain: the caller's record,
 * the key it was registered to replace, or a key registered to replace it.
 *
 * ONE STEP IN EITHER DIRECTION AND NO FURTHER. A rotation only ever needs the
 * three — the new key confirms itself, and reads the old one it is about to
 * revoke — and walking the chain further would put keys the caller can do
 * nothing about back into the answer, which is the enumeration this exists to
 * stop.
 */
function inLineageOf(caller: TrustedOperator, key: TrustedOperator): boolean {
  return key.id === caller.id || key.id === caller.supersedes || key.supersedes === caller.id;
}

/**
 * Checks a registration that ADDS reach to the fleet, rather than one that
 * carries a key's own reach onto its replacement.
 *
 * Two rules, and both are about a scope being STATED rather than inherited by
 * accident:
 *
 * An operator-tier key must name what it reaches, which now bites the ordinary
 * admin enrollment — an admin carries no scope, so there is nothing for the new
 * key to inherit, and what used to quietly mean "every project" has to be said.
 *
 * And a fresh wildcard takes an ADMIN. A key that reaches every project is the
 * widest operator-tier grant there is, and letting one mint another beside
 * itself would make the grant self-propagating: the admin who approved one
 * wildcard key would have approved every wildcard key. Rotation is the exception
 * and does not come through here, so a wildcard key still replaces itself.
 *
 * Throws `ScafoError("invalid-input")` for the first and
 * `ScafoError("auth-scope")` for the second, which is the split those two codes
 * always carry: what was asked for cannot exist, versus this caller cannot ask.
 */
function assertFreshGrant(
  caller: TrustedOperator,
  granted: Pick<TrustedOperator, "role" | "projects">,
): void {
  assertGrantableScope(granted);

  if (isWildcardScope(granted.projects) && caller.role !== "admin") {
    throw new ScafoError("auth-scope", "Only an admin grants every project", {
      detail:
        `"${WILDCARD_PROJECT}" reaches every project of this fleet, and "${caller.id}" is an ` +
        `${caller.role}-tier key: it may replace itself with one, and may not hand one out ` +
        `beside itself; name the projects this key is for, or ask an admin of this fleet`,
    });
  }
}

/**
 * The caller as the guard read it. Every route here stands behind
 * `requireOperatorToken`, so its absence is a wiring mistake rather than
 * something a request can cause.
 */
function requireCaller(event: H3Event): TrustedOperator {
  const caller = operatorIdentity(event);
  if (caller !== undefined) return caller;

  throw new ScafoError("auth-scope", "Not an operator of this fleet", {
    detail: `"${nodeIdentity(event)?.nodeId ?? "the caller"}" was not resolved to an operator key`,
  });
}

/** Reads the body of a trust request: an id, the public half, and what it asks to be. */
async function readTrustRequest(event: H3Event): Promise<TrustRequest> {
  let parsed: unknown;
  try {
    parsed = await event.req.json();
  } catch (error) {
    throw malformed("the body is not valid JSON", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw malformed("the body must hold a JSON object");
  }

  const body = parsed as {
    id?: unknown;
    publicKey?: unknown;
    role?: unknown;
    supersedes?: unknown;
    projects?: unknown;
  };
  if (typeof body.id !== "string" || body.id === "") throw malformed(`"id" must be given`);

  const key = body.publicKey as { kty?: unknown; crv?: unknown; x?: unknown } | null | undefined;
  if (typeof key !== "object" || key === null || key.kty !== "OKP" || key.crv !== "Ed25519") {
    throw malformed(`"publicKey" must be an Ed25519 JWK`);
  }
  if (typeof key.x !== "string" || key.x === "") {
    throw malformed(`"publicKey.x" must carry the public half`);
  }
  if (body.role !== undefined && body.role !== "admin" && body.role !== "operator") {
    throw malformed(`"role" must be "admin" or "operator" when it is given at all`);
  }
  if (body.supersedes !== undefined && typeof body.supersedes !== "string") {
    throw malformed(`"supersedes" must be the id of the key this one replaces`);
  }
  /* SHAPE only. What a scope may hold — a slug or the lone wildcard, at least
     one of them, and never on an admin — belongs to the registry, so an operator
     reads the same refusal whichever way they reached the installation. */
  if (
    body.projects !== undefined &&
    (!Array.isArray(body.projects) || body.projects.some((entry) => typeof entry !== "string"))
  ) {
    throw malformed(`"projects" must be a list of project slugs, or ["${WILDCARD_PROJECT}"]`);
  }

  /*
   * The PUBLIC half and nothing else reaches the record. A body carrying a `d`
   * would be an operator posting their private key to a node by mistake, and
   * copying it into the registry — where every node of the fleet reads it —
   * would turn that mistake into a disclosure.
   */
  return {
    key: {
      id: body.id,
      publicKey: { kty: "OKP", crv: "Ed25519", x: key.x },
      ...(body.supersedes === undefined ? {} : { supersedes: body.supersedes }),
    },
    ...(body.role === undefined ? {} : { role: body.role }),
    ...(body.projects === undefined ? {} : { projects: body.projects as string[] }),
  };
}

function malformed(detail: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Malformed request", { detail, cause });
}
