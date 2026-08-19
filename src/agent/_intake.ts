/* Internal: reading and authenticating what the deploy-facing routes are sent. */

import type { H3Event } from "h3";
import type { NodeIdentity, NodeVerifier } from "../core/auth/node-token.ts";
import type { OidcIdentity, OidcVerifier } from "../core/auth/oidc.ts";
import { isScaloError, ScaloError } from "../core/error.ts";
import { assertId } from "../core/registry/paths.ts";
import type { BuildSource } from "../core/types/registry.ts";
import { assertSlug } from "../core/utils/slug.ts";
import type { DeployMeta } from "./deploys.ts";
import { bearerToken } from "./middleware.ts";

/** Environment a deploy lands in when the caller names none. */
export const DEFAULT_ENVIRONMENT: string = "production";

/** Who a deploy-facing route admitted. */
export type DeployCaller =
  | { kind: "node"; identity: NodeIdentity }
  | { kind: "workload"; identity: OidcIdentity };

/** The two ways a deploy-facing route can be authenticated, built once per app. */
export interface DeployVerifiers {
  node: NodeVerifier;
  oidc: OidcVerifier;
}

/** The parts of a deploy upload. */
export interface DeployRequest {
  meta: DeployMeta;
  artifact: Uint8Array;
}

/** What `POST /v1/aliases` is asked to do. */
export interface AliasRequest {
  project: string;
  environment: string;
  /** Build to point the environment at; absent only on a rollback. */
  build?: string;
  rollback: boolean;
}

/**
 * Authenticates a caller that may be an operator holding a node key, or a
 * project's own CI workload holding an OIDC token.
 *
 * The bearer is tried as a node token first, because that needs nothing but the
 * token itself. Only when that fails as authentication is it offered to the
 * project's trust policy — `project` is `null` when there is no project to check
 * it against, and the node token is then the only way in.
 *
 * A caller that fails both is answered with the one `ScaloError("auth-invalid")`
 * every rejection shares, so it cannot learn which of the two it failed, nor
 * whether the project exists. A trust denial is the single exception: the caller
 * proved who it is and the project simply does not admit it, which is
 * authorization and stays distinguishable as `ScaloError("trust-mismatch")`.
 */
export async function verifyCaller(
  verifiers: DeployVerifiers,
  event: H3Event,
  project: string | null,
): Promise<DeployCaller> {
  const operator = await tryNodeToken(verifiers, event);
  if (operator !== null) return operator;

  /* Nothing to check a workload token against, so the node token was the only
     way in and its rejection stands. */
  if (project === null) throw authInvalid();
  return verifyWorkload(verifiers, event, project);
}

/**
 * The operator half of {@link verifyCaller}, on its own: it needs nothing but
 * the `Authorization` header, so a route with a body worth not reading can try
 * it before reading one.
 *
 * Resolves null when the token is simply not a valid node token — including when
 * there is no token at all. Anything that is not an authentication failure, such
 * as the registry being unreadable, is raised instead of swallowed.
 */
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
    if (isScaloError(error) && error.code === "auth-invalid") return null;
    throw error;
  }
}

/** The workload half of {@link verifyCaller}, checked against one project. */
export async function verifyWorkload(
  verifiers: DeployVerifiers,
  event: H3Event,
  project: string,
): Promise<DeployCaller> {
  /* Reads the header again rather than being handed the token: it is the same
     header, and the two halves stay independently callable. */
  const token = bearerToken(event);

  try {
    return { kind: "workload", identity: await verifiers.oidc.verify(token, project) };
  } catch (error) {
    if (isScaloError(error) && error.code === "trust-mismatch") throw error;
    throw authInvalid(error);
  }
}

/**
 * Reads a deploy upload: a `meta` part carrying JSON and an `artifact` part
 * carrying the archive.
 *
 * The body is buffered before the caller is authenticated, because which project
 * a workload token is checked against is stated in `meta`. The agent listener
 * only ever faces a trusted network, which is what makes that acceptable.
 */
export async function readDeployRequest(event: H3Event): Promise<DeployRequest> {
  let form: FormData;
  try {
    form = await event.req.formData();
  } catch (error) {
    throw invalid("the body could not be read as multipart/form-data", error);
  }

  const meta = form.get("meta");
  if (typeof meta !== "string") throw invalid(`the "meta" part is missing or is not text`);

  const artifact = form.get("artifact");
  if (!(artifact instanceof Blob)) throw invalid(`the "artifact" part is missing or is not a file`);

  return { meta: parseMeta(meta), artifact: new Uint8Array(await artifact.arrayBuffer()) };
}

/** Reads the JSON body of an alias change. */
export async function readAliasRequest(event: H3Event): Promise<AliasRequest> {
  const body = asObject(await readJsonBody(event), "the body");

  const project = text(body, "project", true);
  assertSlug(project);
  const environment = text(body, "environment", true);
  assertSlug(environment);
  const rollback = flag(body, "rollback") ?? false;

  if (rollback) return { project, environment, rollback };

  const build = text(body, "build", true);
  assertId(build);
  return { project, environment, build, rollback };
}

function parseMeta(raw: string): DeployMeta {
  const body = asObject(parseJson(raw, `the "meta" part`), `the "meta" part`);

  const project = text(body, "project", true);
  assertSlug(project);
  const environment = text(body, "environment") ?? DEFAULT_ENVIRONMENT;
  assertSlug(environment);
  const script = text(body, "script") ?? project;
  assertSlug(script);

  const runtimeConfigurable = flag(body, "runtimeConfigurable");
  if (runtimeConfigurable === undefined) {
    throw invalid(`"runtimeConfigurable" must be stated, as true or as false`);
  }

  const meta: DeployMeta = {
    project,
    environment,
    script,
    runtimeConfigurable,
    flip: flag(body, "flip") ?? false,
  };

  const buildId = text(body, "buildId");
  if (buildId !== undefined) {
    assertId(buildId);
    meta.buildId = buildId;
  }
  const builtWithVarset = text(body, "builtWithVarset");
  if (builtWithVarset !== undefined) {
    assertId(builtWithVarset);
    meta.builtWithVarset = builtWithVarset;
  }
  const source = readSource(body.source);
  if (source !== undefined) meta.source = source;

  return meta;
}

function readSource(value: unknown): BuildSource | undefined {
  if (value === undefined || value === null) return undefined;

  const raw = asObject(value, `"source"`);
  const source: BuildSource = {
    provider: text(raw, "provider", true),
    repo: text(raw, "repo", true),
    ref: text(raw, "ref", true),
    commit: text(raw, "commit", true),
  };
  const oidcSub = text(raw, "oidcSub");
  if (oidcSub !== undefined) source.oidcSub = oidcSub;
  return source;
}

async function readJsonBody(event: H3Event): Promise<unknown> {
  let raw: string;
  try {
    raw = await event.req.text();
  } catch (error) {
    throw invalid("the body could not be read", error);
  }
  return parseJson(raw, "the body");
}

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw invalid(`${what} is not valid JSON`, error);
  }
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

function flag(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalid(`"${name}" must be true or false`);
  return value;
}

function invalid(detail: string, cause?: unknown): ScaloError {
  return new ScaloError("invalid-input", "Malformed request", { detail, cause });
}

/** The one rejection every authentication failure shares, whatever caused it. */
function authInvalid(cause?: unknown): ScaloError {
  return new ScaloError("auth-invalid", "Authentication failed", { cause });
}
