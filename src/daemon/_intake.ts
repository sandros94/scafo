/* Internal: reading and authenticating what the deploy-facing routes are sent. */

import type { H3Event } from "h3";
import { safeJsonParse } from "unsecure/sanitize";
import type { NodeIdentity, NodeVerifier } from "../core/auth/node-token.ts";
import type { OidcIdentity, OidcVerifier } from "../core/auth/oidc.ts";
import { isScafoError, ScafoError } from "../core/error.ts";
import { assertReplicas } from "../core/placement/replicas.ts";
import { assertSelector } from "../core/placement/selector.ts";
import { assertApplicationScope } from "./_scope.ts";
import type { DeploymentSource, NodeSelector, ReplicaCount } from "../core/types/registry.ts";
import { assertSlug } from "../core/utils/slug.ts";
import { fromBase64Url, toBase64Url } from "../core/utils/base64.ts";
import { stableStringify } from "../core/utils/json.ts";
import type { DeployMeta } from "./deploys.ts";
import { bearerToken } from "./middleware.ts";
import { type JsonBodyOptions, readJsonBody } from "./_json.ts";

/** Who a deploy-facing route admitted. */
export type DeployCaller =
  | { kind: "node"; identity: NodeIdentity }
  | { kind: "workload"; identity: OidcIdentity };

/** The two ways a deploy-facing route can be authenticated, built once per app. */
export interface DeployVerifiers {
  node: NodeVerifier;
  oidc: OidcVerifier;
}

/** Header carrying the bounded, canonical deploy metadata document. */
export const DEPLOY_METADATA_HEADER: string = "x-scafo-deploy";

/** Maximum encoded metadata header length. */
export const DEPLOY_METADATA_MAX_BYTES: number = 8_192;

/** Metadata accepted beside the application path; the server fills its defaults. */
export type DeployMetadata = Partial<Omit<DeployMeta, "application" | "oidc">>;

/** What `POST /v1/applications/:name/selector` is asked to set. */
export interface SelectorRequest {
  /** Labels a node must carry to serve the application; null clears the constraint. */
  selector: NodeSelector | null;
}

/** What `POST /v1/applications/:name/replicas` is asked to set. */
export interface ReplicasRequest {
  /** How many nodes should serve the application. */
  replicas: ReplicaCount;
}

/** Authenticates node/operator or application OIDC callers. Uniform auth failures
    hide token and application details; proven trust denials stay `trust-mismatch`. */
export async function verifyCaller(
  verifiers: DeployVerifiers,
  event: H3Event,
  application: string | null,
): Promise<DeployCaller> {
  const operator = await tryNodeToken(verifiers, event);
  if (operator !== null) {
    if (application !== null && operator.kind === "node") {
      assertApplicationScope(operator.identity, application);
    }
    return operator;
  }

  /* OIDC needs an application trust policy. */
  if (application === null) throw authInvalid();
  return verifyWorkload(verifiers, event, application);
}

/** Tries node-token authentication before reading a deploy body. Only
    `auth-invalid` becomes null; registry failures propagate. */
export async function tryNodeToken(
  verifiers: DeployVerifiers,
  event: H3Event,
): Promise<DeployCaller | null> {
  let token: string;
  try {
    token = bearerToken(event);
  } catch {
    return null;
  }

  try {
    return { kind: "node", identity: await verifiers.node.verify(token) };
  } catch (error) {
    if (isScafoError(error) && error.code === "auth-invalid") return null;
    throw error;
  }
}

/** The workload half of {@link verifyCaller}, checked against one application. */
export async function verifyWorkload(
  verifiers: DeployVerifiers,
  event: H3Event,
  application: string,
): Promise<Extract<DeployCaller, { kind: "workload" }>> {
  /* Reads the header again rather than being handed the token: it is the same
     header, and the two halves stay independently callable. */
  const token = bearerToken(event);

  try {
    return { kind: "workload", identity: await verifiers.oidc.verify(token, application) };
  } catch (error) {
    if (isScafoError(error) && error.code === "trust-mismatch") throw error;
    throw authInvalid(error);
  }
}

/** Reads canonical base64url JSON metadata without touching the request body. */
export function readDeployMetadata(event: H3Event, application: string): DeployMeta {
  const encoded = event.req.headers.get(DEPLOY_METADATA_HEADER);
  if (encoded === null || encoded.length === 0) {
    throw invalid(`the "${DEPLOY_METADATA_HEADER}" header is required`);
  }
  if (encoded.length > DEPLOY_METADATA_MAX_BYTES) {
    throw invalid(
      `the "${DEPLOY_METADATA_HEADER}" header exceeds ${String(DEPLOY_METADATA_MAX_BYTES)} bytes`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw invalid(`the "${DEPLOY_METADATA_HEADER}" header is not unpadded base64url`);
  }

  let json: string;
  let parsed: unknown;
  try {
    const bytes = fromBase64Url(encoded);
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    /* A header the caller wrote: read without the keys an object answers for on
       its own, which the canonical form below refuses to match anyway. */
    parsed = safeJsonParse<unknown>(json);
    if (stableStringify(parsed) !== json || toBase64Url(bytes) !== encoded) {
      throw new Error("non-canonical metadata");
    }
  } catch (error) {
    throw invalid(`the "${DEPLOY_METADATA_HEADER}" header is malformed or non-canonical`, error);
  }
  return parseMeta(parsed, application);
}

/** Encodes the metadata shape the CLI sends in {@link DEPLOY_METADATA_HEADER}. */
export function encodeDeployMetadata(meta: DeployMetadata): string {
  return toBase64Url(new TextEncoder().encode(stableStringify(meta)));
}

/** Reads selector change JSON. `null` clears; omission is refused. */
export async function readSelectorRequest(
  event: H3Event,
  opts?: JsonBodyOptions,
): Promise<SelectorRequest> {
  const body = asObject(await readJsonBody(event, opts), "the body");

  const selector = body.selector;
  if (selector === null) return { selector: null };
  if (selector === undefined) {
    throw invalid(`"selector" must be given: an object of labels, or null to clear it`);
  }
  assertSelector(selector);
  return { selector };
}

/** Reads a replica-count change. The count must be given; there is no default. */
export async function readReplicasRequest(
  event: H3Event,
  opts?: JsonBodyOptions,
): Promise<ReplicasRequest> {
  const body = asObject(await readJsonBody(event, opts), "the body");

  const replicas = body.replicas;
  if (replicas === undefined || replicas === null) {
    throw invalid(`"replicas" must be given: "all", or a whole number of at least 1`);
  }
  assertReplicas(replicas);
  return { replicas };
}

function parseMeta(parsed: unknown, application: string): DeployMeta {
  const body = asObject(parsed, `deploy metadata`);
  if (body.application !== undefined) {
    throw invalid(
      `"application" belongs in the request path and is not accepted in deploy metadata`,
    );
  }
  if (body.oidc !== undefined) {
    throw invalid(
      `"oidc" is not accepted; OIDC provenance is recorded from the verified workload token`,
    );
  }

  assertSlug(application);
  const meta: DeployMeta = { application };

  /* Omitted placement preserves the application's existing settings. */
  if (body.replicas !== undefined && body.replicas !== null) {
    assertReplicas(body.replicas);
    meta.replicas = body.replicas;
  }

  /* Omitted selector preserves existing constraints. */
  if (body.nodeSelector !== undefined && body.nodeSelector !== null) {
    assertSelector(body.nodeSelector);
    meta.nodeSelector = body.nodeSelector;
  }

  const source = readSource(body.source);
  if (source !== undefined) meta.source = source;

  return meta;
}

function readSource(value: unknown): DeploymentSource | undefined {
  if (value === undefined || value === null) return undefined;

  const raw = asObject(value, `"source"`);
  if (raw.oidcSub !== undefined) {
    throw invalid(
      `"source.oidcSub" is not accepted; OIDC provenance is recorded from the verified workload token`,
    );
  }
  const source: DeploymentSource = {
    provider: text(raw, "provider", true),
    repo: text(raw, "repo", true),
    ref: text(raw, "ref", true),
    commit: text(raw, "commit", true),
  };
  return source;
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${what} must hold a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** A non-blank string field; `required` turns a missing one into a rejection. */
function text(body: Record<string, unknown>, name: string, required: true): string;
function text(body: Record<string, unknown>, name: string): string | undefined;
function text(body: Record<string, unknown>, name: string, required?: true): string | undefined {
  const value = body[name];
  if (value === undefined || value === null || value === "") {
    if (required !== true) return undefined;
    throw invalid(`"${name}" must be given`);
  }
  if (typeof value !== "string") throw invalid(`"${name}" must be a string`);
  return value;
}

function invalid(detail: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Malformed request", { detail, cause });
}

/** The one rejection every authentication failure shares, whatever caused it. */
function authInvalid(cause?: unknown): ScafoError {
  return new ScafoError("auth-invalid", "Authentication failed", { cause });
}
