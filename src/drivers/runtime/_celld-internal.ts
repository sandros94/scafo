/*
 * The bounded client for celld's unauthenticated internal listener. Nothing
 * here belongs on an ingress route: only this node may issue these operations.
 */

import { assertPositiveSafeInteger } from "../../core/utils/number.ts";
import {
  callCelldInternal,
  celldInternalOrigin,
  invalidCelldInternalResponse,
} from "./_celld-internal-call.ts";
import type {
  CelldInternalCallOptions,
  CelldInternalClient,
  CelldInternalClientOptions,
  CelldInternalResponse,
  CelldInternalState,
  CelldReloadOutcome,
} from "./_celld-internal-contract.ts";

export type {
  CelldActorStoppedState,
  CelldAdopted,
  CelldAdoptionFailed,
  CelldDeploymentState,
  CelldInternalCallOptions,
  CelldInternalClient,
  CelldInternalClientOptions,
  CelldInternalState,
  CelldReloadOutcome,
  CelldReloadUnavailable,
  CelldUnchanged,
} from "./_celld-internal-contract.ts";

/** Maximum time one internal operator call gets unless the caller narrows it. */
export const DEFAULT_CELLD_INTERNAL_TIMEOUT_MS: number = 120_000;

/** Creates a client for one celld process's internal-listener origin. */
export function createCelldInternalClient(
  endpoint: string,
  opts?: CelldInternalClientOptions,
): CelldInternalClient {
  const origin = celldInternalOrigin(endpoint);
  const fetchFn: typeof fetch = opts?.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CELLD_INTERNAL_TIMEOUT_MS;
  assertPositiveSafeInteger(timeoutMs, "celld internal timeout");

  return {
    async reload(callOpts?: CelldInternalCallOptions): Promise<CelldReloadOutcome> {
      const response = await callCelldInternal(origin, {
        method: "POST",
        path: "/reload",
        fetchFn,
        timeoutMs,
        ...(callOpts?.signal === undefined ? {} : { signal: callOpts.signal }),
      });
      return decodeReload(response);
    },
    async state(callOpts?: CelldInternalCallOptions): Promise<CelldInternalState> {
      const response = await callCelldInternal(origin, {
        method: "GET",
        path: "/state",
        fetchFn,
        timeoutMs,
        ...(callOpts?.signal === undefined ? {} : { signal: callOpts.signal }),
      });
      return decodeState(response);
    },
  };
}

function decodeReload(response: CelldInternalResponse): CelldReloadOutcome {
  const { body, status, method, path } = response;
  if (!isRecord(body)) {
    throw invalidCelldInternalResponse(method, path, "answered a non-object body");
  }

  if (
    status === 200 &&
    body.ok === true &&
    body.outcome === "adopted" &&
    isGeneration(body.generation) &&
    typeof body.version === "string" &&
    typeof body.prefix === "string"
  ) {
    return {
      outcome: "adopted",
      generation: body.generation,
      version: body.version,
      prefix: body.prefix,
    };
  }
  if (
    status === 200 &&
    body.ok === true &&
    body.outcome === "unchanged" &&
    isGeneration(body.generation) &&
    typeof body.version === "string" &&
    (body.prefix === undefined || typeof body.prefix === "string")
  ) {
    return {
      outcome: "unchanged",
      generation: body.generation,
      version: body.version,
      ...(body.prefix === undefined ? {} : { prefix: body.prefix }),
    };
  }
  if (
    status === 422 &&
    body.ok === false &&
    body.outcome === "failed" &&
    typeof body.version === "string" &&
    typeof body.prefix === "string" &&
    typeof body.error === "string"
  ) {
    return { outcome: "failed", version: body.version, prefix: body.prefix, error: body.error };
  }
  if (
    status === 503 &&
    body.ok === false &&
    body.outcome === "unavailable" &&
    typeof body.error === "string"
  ) {
    return { outcome: "unavailable", error: body.error };
  }
  throw invalidCelldInternalResponse(
    method,
    path,
    `answered status ${String(status)} with an invalid outcome`,
  );
}

function decodeState(response: CelldInternalResponse): CelldInternalState {
  const { body, status, method, path } = response;
  if (status !== 200 || !isRecord(body)) {
    throw invalidCelldInternalResponse(
      method,
      path,
      `answered status ${String(status)} with an invalid state`,
    );
  }
  if (body.error === "actor_stopped") return { error: "actor_stopped" };

  const deployment = body.deployment;
  if (
    !isRecord(deployment) ||
    typeof deployment.version !== "string" ||
    typeof deployment.prefix !== "string" ||
    !isGeneration(deployment.generation)
  ) {
    throw invalidCelldInternalResponse(method, path, "answered a state without a valid deployment");
  }
  return {
    deployment: {
      version: deployment.version,
      prefix: deployment.prefix,
      generation: deployment.generation,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
