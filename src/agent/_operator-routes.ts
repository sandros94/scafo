/*
 * Internal: the `/v1/operators` routes — the keys a fleet trusts, administered
 * through a node rather than through the bucket.
 *
 * Bucket-side registration came first and stays: an installation is bootstrapped
 * before there is an agent to bootstrap it through, and a fleet whose keys have
 * all been lost is recovered the same way. What these routes add is the case
 * where an operator has a WORKING key and wants a different one — a rotation —
 * which needs no bucket credential at all, because the key being replaced is
 * what authorizes replacing it.
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
  canGrantRole,
  canRevoke,
  DEFAULT_OPERATOR_ROLE,
  listOperators,
  type OperatorRole,
  revokeOperator,
  type TrustedOperator,
  trustOperator,
} from "../core/registry/operators.ts";
import type { AgentContext } from "./app.ts";
import { nodeIdentity, operatorIdentity } from "./middleware.ts";

/** Where the trusted-key surface lives. */
export const OPERATORS_PATH: string = "/v1/operators";

/** What a registration asks for, over and above the key itself. */
interface TrustRequest {
  key: Omit<TrustedOperator, "role">;
  /** Tier the caller named, or undefined to take the surface's default. */
  role?: OperatorRole;
}

/** Body of `GET /v1/operators`: every key the fleet trusts, in id order. */
export interface OperatorsResult {
  operators: TrustedOperator[];
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
export function registerOperatorRoutes(app: H3, agent: AgentContext, guard: Middleware): void {
  const guarded = { middleware: [guard] };

  /*
   * The read-back half of a rotation: an operator that has just registered a key
   * asks this WITH THAT KEY, which proves the registration landed and that the
   * fleet accepts what it signs — both, in one call, before anything local is
   * repointed at it.
   *
   * BOTH TIERS MAY READ IT, and they have to: that confirm step is the middle of
   * an operator-tier rotation, and a listing is what says which keys a fleet
   * trusts and at what tier — nothing in it is a secret, since the private
   * halves live nowhere near the registry.
   */
  app.get(
    OPERATORS_PATH,
    async (): Promise<OperatorsResult> => ({ operators: await listOperators(agent.registry) }),
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
            `one; an admin of this fleet can, and "scafo fleet keys" says which keys those are`,
        });
      }

      const operator = await trustOperator(agent.registry, { ...request.key, role });
      agent.observability?.emit({
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
            `"scafo fleet rotate", which registers the new key and proves it before this one ` +
            `is dropped, or have another operator revoke it`,
        });
      }
      if (!canRevoke(caller, id)) {
        throw new ScafoError("auth-scope", "Beyond this operator's tier", {
          detail:
            `"${caller.id}" is an ${caller.role}-tier key: it may revoke only the key it was ` +
            `registered to replace, which "${id}" is not; an admin of this fleet can revoke it, ` +
            `and "scafo fleet keys" says which keys those are`,
        });
      }

      const removed = await revokeOperator(agent.registry, id);
      agent.observability?.emit({
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
  };
}

function malformed(detail: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Malformed request", { detail, cause });
}
