/*
 * Deploy records: where a deploy's state lives, so that any node of the
 * installation answers a poll and a node restarting mid-deploy loses nothing.
 */

import { ScafoError, type ScafoErrorCode } from "../error.ts";
import type {
  DeploymentSource,
  CarriedVarset,
  DeployRecord,
  DeployState,
  OidcActor,
} from "../types/registry.ts";
import { formatDuration, isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, readJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { deployKey, deploysPrefix, parseDeployId } from "./paths.ts";

/**
 * How long a finished deploy's record is kept before the reaper deletes it.
 *
 * A week: long enough that an operator coming back to a pipeline run from last
 * Friday still finds out what happened to it, and short enough that a busy
 * project's deploy history does not grow without bound. Nothing reads these
 * records after the fact — a deployment record is what a deploy that succeeded
 * leaves behind — so this is a support window, not history.
 */
export const DEPLOY_RECORD_RETENTION_MS: number = 7 * 24 * 60 * 60 * 1000;

/** The states a deploy stops moving in, and never moves out of again. */
const TERMINAL: ReadonlySet<DeployState> = new Set<DeployState>(["deployed", "failed"]);

/** Whether `state` is one a deploy has stopped moving in. */
export function isDeployTerminal(state: DeployState): boolean {
  return TERMINAL.has(state);
}

/** What a node knows about a deploy the moment it accepts it. */
export interface DeployRecordInput {
  /** `<project>.<16 hex>`, minted by the accepting node. */
  id: string;
  environment: string;
  /** Node accepting the deploy; the reaper measures its liveness against this. */
  node: string;
  source?: DeploymentSource;
  /** Auth-owned workload identity; deploy intake, not request metadata, sets this. */
  oidc?: OidcActor;
}

/** What one state transition writes; `updatedAt` is the registry's to stamp. */
export interface DeployRecordPatch {
  state: DeployState;
  /** The deployment the deploy produced, by version. */
  deployment?: string;
  varset?: CarriedVarset;
  /** The code of the error that failed it, when it was a typed one. */
  code?: ScafoErrorCode;
  detail?: string;
}

/**
 * Records an accepted deploy. The id is the caller's only handle on it, so this
 * happens before one is answered: a handle nothing is recorded under is a handle
 * no node could ever answer for.
 *
 * Throws `ScafoError("immutable")` when the id is already taken — ids are minted
 * from 64 random bits, so a collision is a second deploy claiming the first
 * one's handle rather than a retry of the same work.
 */
export async function createDeployRecord(
  ctx: RegistryContext,
  project: string,
  input: DeployRecordInput,
): Promise<DeployRecord> {
  const at = nowIso(ctx);
  const record: DeployRecord = {
    v: 1,
    id: input.id,
    project,
    environment: input.environment,
    state: "accepted",
    node: input.node,
    acceptedAt: at,
    updatedAt: at,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.oidc === undefined ? {} : { oidc: input.oidc }),
  };

  try {
    await createJson(ctx, deployKey(project, input.id), record);
    return record;
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    throw new ScafoError("immutable", "Deploy already exists", {
      detail: `"${input.id}" is already recorded in project "${project}"`,
      cause: error,
    });
  }
}

/**
 * Moves a deploy to its next state, stamping the moment it moved.
 *
 * Throws `ScafoError("cas-conflict")` for a deploy that has already finished.
 * Terminal means terminal: a deploy that reached `deployed` HAPPENED — its
 * revision is in the registry and the environment is serving the deployment —
 * and a late refusal from the accepting node, or a reaper that decided the node
 * was gone, must not rewrite the outcome.
 */
export async function updateDeployRecord(
  ctx: RegistryContext,
  project: string,
  id: string,
  patch: DeployRecordPatch,
): Promise<DeployRecord> {
  /* Decided inside the read-modify-write, so the answer is measured against
     what is stored now rather than what a caller last read. The refusal shares
     its code with a lost conditional write, which the loop retries from a fresh
     read; this one is final, so it is told apart by identity and not retried. */
  let refusal: ScafoError | undefined;
  const updated = await updateJson<DeployRecord>(
    ctx,
    deployKey(project, id),
    (current) => {
      if (isDeployTerminal(current.state) && current.state !== patch.state) {
        refusal = new ScafoError("cas-conflict", "Deploy has already finished", {
          detail:
            `"${id}" of project "${project}" is ${current.state}, and a deploy that has ` +
            `finished never moves again`,
        });
        throw refusal;
      }
      return { ...current, ...patch, updatedAt: nowIso(ctx) };
    },
    { isRetryable: (error) => error !== refusal && isCasConflict(error) },
  );
  return updated.value;
}

/** One deploy record. Throws `ScafoError("not-found")` when there is none. */
export async function getDeployRecord(
  ctx: RegistryContext,
  project: string,
  id: string,
): Promise<DeployRecord> {
  const found = await readJson<DeployRecord>(ctx, deployKey(project, id));
  if (found === null) {
    throw new ScafoError("not-found", "No such deploy", {
      detail:
        `no deploy "${id}" is recorded in project "${project}"; a deploy's record is kept ` +
        `for ${formatDuration(DEPLOY_RECORD_RETENTION_MS)} after it finishes and then deleted`,
    });
  }
  return found.value;
}

/** Deploy records of `project` in id order; ones deleted while listing are omitted. */
export async function listDeployRecords(
  ctx: RegistryContext,
  project: string,
): Promise<DeployRecord[]> {
  const prefix = deploysPrefix(project);
  const records: DeployRecord[] = [];

  for (const id of namesFromKeys(await ctx.store.list(prefix), prefix).sort()) {
    /* A name that is no deploy id names no record of ours, and reading it would
       be reading whatever else was once written under this prefix. */
    if (parseDeployId(id) === null) continue;

    const found = await readJson<DeployRecord>(ctx, deployKey(project, id));
    if (found !== null) records.push(found.value);
  }
  return records;
}
