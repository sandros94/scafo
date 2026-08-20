/* Internal: uniform rejection, plus unverified reads of a compact token. */

import { ScafoError } from "../error.ts";
import { fromBase64Url } from "../utils/base64.ts";

/**
 * Every rejected token fails identically: one code, one message, no detail. The
 * specific reason travels in `cause` for the server's logs — a caller must not
 * be able to tell an expired token from an unknown key, a replayed `jti`, or a
 * forged signature.
 */
export function authInvalid(reason: string, cause?: unknown): ScafoError {
  return new ScafoError("auth-invalid", "Authentication failed", {
    cause: cause === undefined ? new Error(reason) : new Error(reason, { cause }),
  });
}

/**
 * Protected header of a compact JWS, before any signature check. Only used to
 * learn which key and algorithm the token claims — never to trust a value.
 */
export function decodeCompactHeader(token: string): Record<string, unknown> {
  return decodeSegment(segment(token, 0), "header");
}

/** Claims of a compact JWS, before any signature check. See {@link decodeCompactHeader}. */
export function decodeCompactClaims(token: string): Record<string, unknown> {
  return decodeSegment(segment(token, 1), "claims");
}

/** Reads a claim that must be a non-empty string. */
export function stringClaim(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if (typeof value !== "string" || value.length === 0) {
    throw authInvalid(`Claim "${name}" is missing or not a non-empty string`);
  }
  return value;
}

/** Reads a claim that must be a finite number (a JWT `NumericDate`, usually). */
export function numberClaim(claims: Record<string, unknown>, name: string): number {
  const value = claims[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw authInvalid(`Claim "${name}" is missing or not a finite number`);
  }
  return value;
}

/** Narrows a verified JWS payload to a claim set; non-JSON payloads are rejected. */
export function asClaims(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw authInvalid("Token payload is not a JSON object");
  }
  return payload as Record<string, unknown>;
}

function segment(token: string, index: number): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw authInvalid("Token is not a compact JWS");
  return parts[index] ?? "";
}

function decodeSegment(part: string, what: string): Record<string, unknown> {
  let json: string;
  try {
    json = new TextDecoder().decode(fromBase64Url(part));
  } catch (error) {
    throw authInvalid(`Token ${what} is not base64url`, error);
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw authInvalid(`Token ${what} is not JSON`, error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw authInvalid(`Token ${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}
