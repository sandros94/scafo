/*
 * Internal: the fleet deployment pointer celld maintains, and the reads and
 * writes that move it.
 *
 * CAVEAT: this is a format celld publishes, not one scafo defines, and it is
 * pinned to celld 0.2.x. Pointers are therefore rewritten by spreading the one
 * already in the bucket and replacing only the fields that select a version, so
 * anything a newer celld adds survives a scafo activation untouched.
 */

import { ScafoError } from "../../core/error.ts";
import { putJson, readJson, type Versioned } from "../../core/registry/cas.ts";
import type { RegistryContext } from "../../core/registry/context.ts";

/**
 * What a starting celld process reads to learn which version to serve.
 *
 * `prefix` is the load-bearing field: the runtime resolves a version's modules
 * under it and never looks at `version`, which is metadata for tooling.
 */
export interface DeployPointer {
  /** Worker name the version was deployed under; pointers written by older celld omit it. */
  script_name?: string;
  /** Deployment id of the version. */
  version: string;
  /** Fleet-relative directory holding the version: `deploy/<script>/<version>`. */
  prefix: string;
  /** celld writes 100 and does not split traffic on it. */
  rollout: { percent: number };
}

/** Key of the fleet-wide pointer, or of one script's pointer when `script` is given. */
export function deployPointerKey(fleetPrefix: string, script?: string): string {
  return script === undefined
    ? `${fleetPrefix}/deploy/current.json`
    : `${fleetPrefix}/deploy/${script}/current.json`;
}

/** Fleet-relative directory a version's modules live in. */
export function versionPrefix(script: string, version: string): string {
  return `deploy/${script}/${version}`;
}

/**
 * Reads the fleet-wide pointer, which every activation starts from: it carries
 * the script name a version directory is addressed under.
 *
 * Throws `ScafoError("not-found")` when the fleet has never been deployed to —
 * there is no name to activate a version under, and writing a guess would point
 * the fleet at a directory that does not exist.
 */
export async function readFleetPointer(
  ctx: RegistryContext,
  fleetPrefix: string,
): Promise<Versioned<DeployPointer>> {
  const key = deployPointerKey(fleetPrefix);
  const current = await readJson<DeployPointer>(ctx, key);

  if (current === null) {
    throw new ScafoError("not-found", "Fleet has no deployment", {
      detail: `"${key}" does not exist: nothing has been deployed to this fleet yet`,
    });
  }
  return current;
}

/**
 * Name a fleet's versions are deployed under. Older pointers carry it only
 * inside `prefix`, so it is recovered from there when the field is absent.
 */
export function scriptNameOf(pointer: DeployPointer, key: string): string {
  if (pointer.script_name !== undefined && pointer.script_name !== "") return pointer.script_name;

  const segments = pointer.prefix.split("/");
  const script = segments.length === 3 && segments[0] === "deploy" ? segments[1] : undefined;
  if (script === undefined || script === "") {
    throw new ScafoError("store-nonconforming", "Deployment pointer names no script", {
      detail: `"${key}" has neither a script name nor a "deploy/<script>/<version>" prefix`,
    });
  }
  return script;
}

/**
 * Points one pointer object at `version`, preserving every other field it
 * carries. Conditional on the bytes that were read, so a concurrent writer
 * produces a losing write rather than a lost one.
 *
 * A pointer that already names the version is left untouched: an activation is
 * planned again on every pass until a process for that build is running, and
 * rewriting identical bytes would only add bucket churn and lose races to
 * writers that have something to say.
 */
export async function pointAtVersion(
  ctx: RegistryContext,
  key: string,
  input: { script: string; version: string; template: DeployPointer },
): Promise<void> {
  const current = await readJson<DeployPointer>(ctx, key);
  const base = current?.value ?? input.template;
  const prefix = versionPrefix(input.script, input.version);
  if (current !== null && base.version === input.version && base.prefix === prefix) return;

  const next: DeployPointer = {
    ...base,
    script_name: input.script,
    version: input.version,
    prefix,
  };
  await putJson(
    ctx,
    key,
    next,
    current === null ? { ifNoneMatch: "*" } : { ifMatch: current.etag },
  );
}
