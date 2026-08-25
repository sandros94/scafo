/* Internal: reading and authenticating what the deploy-facing routes are sent. */

import type { H3Event } from "h3";
import type { NodeIdentity, NodeVerifier } from "../core/auth/node-token.ts";
import type { OidcIdentity, OidcVerifier } from "../core/auth/oidc.ts";
import { isScafoError, ScafoError } from "../core/error.ts";
import { assertReplicas } from "../core/placement/replicas.ts";
import { assertSelector } from "../core/placement/selector.ts";
import type { CanaryInput } from "../core/registry/environments.ts";
import { assertId } from "../core/registry/paths.ts";
import { assertProjectScope } from "./_scope.ts";
import type { BuildSource, NodeSelector, ParkPolicy, SplitEntry } from "../core/types/registry.ts";
import { assertSlug } from "../core/utils/slug.ts";
import { fromBase64Url, toBase64Url } from "../core/utils/base64.ts";
import { stableStringify } from "../core/utils/json.ts";
import type { DeployMeta } from "./deploys.ts";
import { bearerToken } from "./middleware.ts";
import { type JsonBodyOptions, readJsonBody } from "./_json.ts";

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

/** Header carrying the bounded, canonical deploy metadata document. */
export const DEPLOY_METADATA_HEADER: string = "x-scafo-deploy";

/** Maximum encoded metadata header length. */
export const DEPLOY_METADATA_MAX_BYTES: number = 8_192;

/** Metadata accepted beside the project path; the server fills its defaults. */
export type DeployMetadata = Partial<Omit<DeployMeta, "project" | "oidc" | "runtimeConfigurable">> &
  Pick<DeployMeta, "runtimeConfigurable">;

/** What `POST /v1/environments/:project/:env/selector` is asked to set. */
export interface SelectorRequest {
  /** Labels a node must carry to serve the environment; null clears the constraint. */
  selector: NodeSelector | null;
}

/** What `POST /v1/environments/:project/:env/park` is asked to set. */
export interface ParkRequest {
  /** How the environment scales to zero; null clears the policy it carries. */
  policy: ParkPolicy | null;
}

/**
 * What `POST /v1/environments/:project/:env/split` is asked to do: state the
 * legs outright, or state a canary and let the registry weigh it against
 * whatever the alias currently points at.
 */
export type SplitRequest =
  | { kind: "set"; split: SplitEntry[] | null }
  | { kind: "canary"; canary: CanaryInput };

/** What an environment alias change is asked to do. */
export interface AliasRequest {
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
 * A caller that fails both is answered with the one `ScafoError("auth-invalid")`
 * every rejection shares, so it cannot learn which of the two it failed, nor
 * whether the project exists. A trust denial is the single exception: the caller
 * proved who it is and the project simply does not admit it, which is
 * authorization and stays distinguishable as `ScafoError("trust-mismatch")`.
 *
 * An admitted operator's PROJECT SCOPE is checked here too, and here rather than
 * in each route, because this function is already the place a caller and a
 * project meet: a scoped key naming a project outside its list is
 * `ScafoError("auth-scope")`. A `null` project is nothing to check against, and
 * a workload's own scoping is its project's trust policy.
 */
export async function verifyCaller(
  verifiers: DeployVerifiers,
  event: H3Event,
  project: string | null,
): Promise<DeployCaller> {
  const operator = await tryNodeToken(verifiers, event);
  if (operator !== null) {
    if (project !== null && operator.kind === "node") {
      assertProjectScope(operator.identity, project);
    }
    return operator;
  }

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
    if (isScafoError(error) && error.code === "auth-invalid") return null;
    throw error;
  }
}

/** The workload half of {@link verifyCaller}, checked against one project. */
export async function verifyWorkload(
  verifiers: DeployVerifiers,
  event: H3Event,
  project: string,
): Promise<Extract<DeployCaller, { kind: "workload" }>> {
  /* Reads the header again rather than being handed the token: it is the same
     header, and the two halves stay independently callable. */
  const token = bearerToken(event);

  try {
    return { kind: "workload", identity: await verifiers.oidc.verify(token, project) };
  } catch (error) {
    if (isScafoError(error) && error.code === "trust-mismatch") throw error;
    throw authInvalid(error);
  }
}

/** Reads canonical base64url JSON metadata without touching the request body. */
export function readDeployMetadata(event: H3Event, project: string): DeployMeta {
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
    parsed = JSON.parse(json);
    if (stableStringify(parsed) !== json || toBase64Url(bytes) !== encoded) {
      throw new Error("non-canonical metadata");
    }
  } catch (error) {
    throw invalid(`the "${DEPLOY_METADATA_HEADER}" header is malformed or non-canonical`, error);
  }
  return parseMeta(parsed, project);
}

/** Encodes the metadata shape the CLI sends in {@link DEPLOY_METADATA_HEADER}. */
export function encodeDeployMetadata(meta: DeployMetadata): string {
  return toBase64Url(new TextEncoder().encode(stableStringify(meta)));
}

/**
 * Reads the JSON body of a node-selector change: `{"selector": {...}}` to
 * constrain the environment, `{"selector": null}` to lift the constraint.
 *
 * The two are spelled differently because they mean different things, and a
 * MISSING `selector` is neither — it is a request that forgot to say what it
 * wanted, and clearing a constraint is far too consequential to be what an
 * omission defaults to.
 */
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

/**
 * Reads the JSON body of a park-policy change: `{"policy": {...}}` to state how
 * the environment scales to zero, `{"policy": null}` to clear it and fall back
 * to what its kind implies.
 *
 * Read exactly as the selector above is, and a MISSING `policy` is refused for
 * the same reason: it is a request that forgot to say what it wanted, and
 * clearing a policy is not what an omission should default to. Only the SHAPE is
 * checked here — what a field may hold belongs to the registry, so the refusal
 * an operator reads is the same one they would get writing to the bucket.
 */
export async function readParkRequest(
  event: H3Event,
  opts?: JsonBodyOptions,
): Promise<ParkRequest> {
  const body = asObject(await readJsonBody(event, opts), "the body");

  const policy = body.policy;
  if (policy === null) return { policy: null };
  if (policy === undefined) {
    throw invalid(`"policy" must be given: the fields to set, or null to clear it`);
  }
  return { policy: asObject(policy, `"policy"`) as ParkPolicy };
}

/**
 * Reads the JSON body of a traffic-split change: `{"split": [{"build": …,
 * "weight": …}, …]}` to weight the legs, `{"split": null}` to clear them, or
 * `{"canary": {"build": …, "weight": …}}` to weigh one build against the alias.
 *
 * Only the SHAPE is checked here — that the parts are there and are of the right
 * kind. What the numbers must add up to belongs to the registry, so an operator
 * reading a refusal gets the same wording whether they went through a node or
 * wrote to the bucket themselves.
 *
 * A body stating BOTH, or neither, is refused: they are two ways of saying what
 * the split should be, and a request carrying both says nothing about which was
 * meant. A MISSING `split` is not read as "clear", for the reason the selector
 * route does not either — undoing a split is far too consequential to be what an
 * omission defaults to.
 */
export async function readSplitRequest(
  event: H3Event,
  opts?: JsonBodyOptions,
): Promise<SplitRequest> {
  const body = asObject(await readJsonBody(event, opts), "the body");

  const stated = "split" in body;
  const canary = body.canary;
  if (stated && canary !== undefined && canary !== null) {
    throw invalid(`"split" and "canary" ask for opposite things; give one of them`);
  }

  if (canary !== undefined && canary !== null) {
    const raw = asObject(canary, `"canary"`);
    const build = text(raw, "build", true);
    assertId(build);
    if (typeof raw.weight !== "number") throw invalid(`"canary.weight" must be a number`);
    return { kind: "canary", canary: { build, weight: raw.weight } };
  }

  if (!stated) {
    throw invalid(
      `"split" must be given: the legs to weight, or null to clear them — or "canary" ` +
        `to weigh one build against the alias`,
    );
  }

  const split = body.split;
  if (split === null) return { kind: "set", split: null };
  if (!Array.isArray(split)) throw invalid(`"split" must be an array of legs, or null`);

  return { kind: "set", split: split.map((entry, at) => readSplitEntry(entry, at)) };
}

/** Reads the JSON body of an alias change. */
export async function readAliasRequest(
  event: H3Event,
  opts?: JsonBodyOptions,
): Promise<AliasRequest> {
  const body = asObject(await readJsonBody(event, opts), "the body");

  const unknown = Object.keys(body).find((name) => name !== "build" && name !== "rollback");
  if (unknown !== undefined) {
    throw invalid(
      unknown === "project" || unknown === "environment"
        ? `"${unknown}" belongs in the request path`
        : `"${unknown}" is not accepted by an alias change`,
    );
  }
  const rollback = flag(body, "rollback") ?? false;

  if (rollback) return { rollback };

  const build = text(body, "build", true);
  assertId(build);
  return { build, rollback };
}

/** One leg of a stated split, checked for shape alone. */
function readSplitEntry(value: unknown, at: number): SplitEntry {
  const raw = asObject(value, `"split[${String(at)}]"`);

  const build = text(raw, "build", true);
  assertId(build);
  if (typeof raw.weight !== "number") {
    throw invalid(`"split[${String(at)}].weight" must be a number`);
  }
  return { build, weight: raw.weight };
}

function parseMeta(parsed: unknown, project: string): DeployMeta {
  const body = asObject(parsed, `deploy metadata`);
  if (body.project !== undefined) {
    throw invalid(`"project" belongs in the request path and is not accepted in deploy metadata`);
  }
  if (body.oidc !== undefined) {
    throw invalid(
      `"oidc" is not accepted; OIDC provenance is recorded from the verified workload token`,
    );
  }

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

  /* Absent means "say nothing about placement", which is not the same as saying
     "all": the environment keeps whatever it already carries. */
  if (body.replicas !== undefined && body.replicas !== null) {
    assertReplicas(body.replicas);
    meta.replicas = body.replicas;
  }

  /* Read the same way, and for the same reason: a pipeline that never mentions a
     selector must not lift one an operator set. Clearing it is `scafo env
     selector --clear`, which says so out loud. */
  if (body.nodeSelector !== undefined && body.nodeSelector !== null) {
    assertSelector(body.nodeSelector);
    meta.nodeSelector = body.nodeSelector;
  }

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
  if (raw.oidcSub !== undefined) {
    throw invalid(
      `"source.oidcSub" is not accepted; OIDC provenance is recorded from the verified workload token`,
    );
  }
  const source: BuildSource = {
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

function flag(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalid(`"${name}" must be true or false`);
  return value;
}

function invalid(detail: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Malformed request", { detail, cause });
}

/** The one rejection every authentication failure shares, whatever caused it. */
function authInvalid(cause?: unknown): ScafoError {
  return new ScafoError("auth-invalid", "Authentication failed", { cause });
}
