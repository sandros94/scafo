/* Operator-authenticated trusted-key routes. Bucket registration remains for
   bootstrap/recovery; registry helpers enforce tier and scope rules. */

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
  WILDCARD_APPLICATION,
} from "../core/registry/operators.ts";
import type { DaemonContext } from "./app.ts";
import { nodeIdentity, operatorIdentity } from "./middleware.ts";
import { readJsonBody } from "./_json.ts";

/** Where the trusted-key surface lives. */
export const OPERATORS_PATH: string = "/v1/operators";

/** What a registration asks for, over and above the key itself. */
interface TrustRequest {
  key: Omit<TrustedOperator, "role" | "applications">;
  /** Tier the caller named, or undefined to take the surface's default. */
  role?: OperatorRole;
  /**
   * Applications the caller asked to scope the key to, or undefined to take the
   * caller's own scope — which an admin has none of, so an admin enrolling an
   * operator-tier key has to name one.
   */
  applications?: string[];
}

/** Body of `GET /v1/operators`: the keys the fleet trusts that the caller may see, in id order. */
export interface OperatorsResult {
  operators: TrustedOperator[];
  /** `true` when the result is the caller's rotation lineage, not the fleet. */
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

  /* Operators see only their one-step rotation lineage; admins see all keys. */
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

  /* New keys default to least privilege; replacements inherit caller tier and
     are idempotent for interrupted rotations. */
  app.post(
    OPERATORS_PATH,
    async (event): Promise<OperatorTrusted> => {
      const caller = requireCaller(event);
      const request = await readTrustRequest(event, daemon.config.api.jsonBytes);
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

      /* Omitted scope inherits caller reach and cannot widen it. */
      const applications = request.applications ?? caller.applications;
      if (!canGrantScope(caller, applications)) {
        throw new ScafoError("auth-scope", "Beyond this key's applications", {
          detail:
            `"${caller.id}" is scoped to the applications it was enrolled for, and cannot ` +
            `register a key that reaches past them; an admin of this fleet can`,
        });
      }

      /* Replacements carry existing reach; only fresh keys are new grants. */
      if (supersedes !== caller.id) assertFreshGrant(caller, { role, applications });

      const operator = await trustOperator(daemon.registry, {
        ...request.key,
        role,
        ...(applications === undefined ? {} : { applications }),
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

  /* Only admin or a successor may revoke. Self-revocation is refused; registry
     also preserves the last trusted key and admin. */
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

/** Returns the caller, predecessor, or immediate successor only. */
function inLineageOf(caller: TrustedOperator, key: TrustedOperator): boolean {
  return key.id === caller.id || key.id === caller.supersedes || key.supersedes === caller.id;
}

/** Validates a fresh grant: scope is required and only admin grants wildcard. */
function assertFreshGrant(
  caller: TrustedOperator,
  granted: Pick<TrustedOperator, "role" | "applications">,
): void {
  assertGrantableScope(granted);

  if (isWildcardScope(granted.applications) && caller.role !== "admin") {
    throw new ScafoError("auth-scope", "Only an admin grants every application", {
      detail:
        `"${WILDCARD_APPLICATION}" reaches every application of this fleet, and "${caller.id}" ` +
        `is an ${caller.role}-tier key: it may replace itself with one, and may not hand one out ` +
        `beside itself; name the applications this key is for, or ask an admin of this fleet`,
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
async function readTrustRequest(event: H3Event, maxBytes: number): Promise<TrustRequest> {
  const parsed = await readJsonBody(event, { maxBytes });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw malformed("the body must hold a JSON object");
  }

  const body = parsed as {
    id?: unknown;
    publicKey?: unknown;
    role?: unknown;
    supersedes?: unknown;
    applications?: unknown;
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
  /* Registry owns scope policy; this boundary validates only JSON shape. */
  if (
    body.applications !== undefined &&
    (!Array.isArray(body.applications) ||
      body.applications.some((entry) => typeof entry !== "string"))
  ) {
    throw malformed(
      `"applications" must be a list of application names or prefix globs, or ` +
        `["${WILDCARD_APPLICATION}"]`,
    );
  }

  /* Persist only JWK public material; never copy an accidental private `d`. */
  return {
    key: {
      id: body.id,
      publicKey: { kty: "OKP", crv: "Ed25519", x: key.x },
      ...(body.supersedes === undefined ? {} : { supersedes: body.supersedes }),
    },
    ...(body.role === undefined ? {} : { role: body.role }),
    ...(body.applications === undefined ? {} : { applications: body.applications as string[] }),
  };
}

function malformed(detail: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Malformed request", { detail, cause });
}
