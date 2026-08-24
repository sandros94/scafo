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
 */

import type { H3, H3Event, Middleware } from "h3";
import { ScafoError } from "../core/error.ts";
import {
  listOperators,
  revokeOperator,
  type TrustedOperator,
  trustOperator,
} from "../core/registry/operators.ts";
import type { AgentContext } from "./app.ts";
import { nodeIdentity } from "./middleware.ts";

/** Where the trusted-key surface lives. */
export const OPERATORS_PATH: string = "/v1/operators";

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
   */
  app.get(
    OPERATORS_PATH,
    async (): Promise<OperatorsResult> => ({ operators: await listOperators(agent.registry) }),
    guarded,
  );

  /*
   * Idempotent, because the expand half of an expand-contract must be safe to
   * repeat: a rotation interrupted anywhere before its flip is rerun from the
   * beginning, and re-registering the key it had already registered is how that
   * rerun costs nothing.
   */
  app.post(
    OPERATORS_PATH,
    async (event): Promise<OperatorTrusted> => ({
      operator: await trustOperator(agent.registry, await readTrustRequest(event)),
    }),
    guarded,
  );

  /*
   * REFUSES THE CALLER'S OWN KEY, and that refusal is what makes this route
   * incapable of leaving a fleet unreachable: the caller is by definition one of
   * the trusted keys, so a removal it is allowed to make always leaves at least
   * the caller behind. The registry's own last-key guard still stands underneath
   * for the bucket-side path, which has no caller to compare against.
   *
   * Self-revocation is refused rather than supported because it cannot be
   * verified afterwards — the operator would be proving the fleet still works
   * with a key it has just thrown away. Rotation is the same act in the safe
   * order: register the replacement, prove it, and only then drop this one.
   */
  app.delete(
    `${OPERATORS_PATH}/:id`,
    async (event): Promise<OperatorRevoked> => {
      const id = event.context.params?.id ?? "";
      const caller = nodeIdentity(event)?.nodeId;

      if (id === caller) {
        throw new ScafoError("invalid-input", "An operator cannot revoke its own key", {
          detail:
            `"${id}" is the key this request was signed with; replace it with ` +
            `"scafo fleet rotate", which registers the new key and proves it before this one ` +
            `is dropped, or have another operator revoke it`,
        });
      }

      await revokeOperator(agent.registry, id);
      return { removed: id };
    },
    guarded,
  );
}

/* ---------------------------------------------------------------- internals */

/** Reads the body of a trust request: an id, and the public half filed under it. */
async function readTrustRequest(event: H3Event): Promise<TrustedOperator> {
  let parsed: unknown;
  try {
    parsed = await event.req.json();
  } catch (error) {
    throw malformed("the body is not valid JSON", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw malformed("the body must hold a JSON object");
  }

  const body = parsed as { id?: unknown; publicKey?: unknown };
  if (typeof body.id !== "string" || body.id === "") throw malformed(`"id" must be given`);

  const key = body.publicKey as { kty?: unknown; crv?: unknown; x?: unknown } | null | undefined;
  if (typeof key !== "object" || key === null || key.kty !== "OKP" || key.crv !== "Ed25519") {
    throw malformed(`"publicKey" must be an Ed25519 JWK`);
  }
  if (typeof key.x !== "string" || key.x === "") {
    throw malformed(`"publicKey.x" must carry the public half`);
  }

  /*
   * The PUBLIC half and nothing else reaches the record. A body carrying a `d`
   * would be an operator posting their private key to a node by mistake, and
   * copying it into the registry — where every node of the fleet reads it —
   * would turn that mistake into a disclosure.
   */
  return { id: body.id, publicKey: { kty: "OKP", crv: "Ed25519", x: key.x } };
}

function malformed(detail: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Malformed request", { detail, cause });
}
