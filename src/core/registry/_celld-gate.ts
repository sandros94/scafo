/*
 * The gate every command that reads Celld's own keyspace passes first.
 *
 * Scafo reads and deletes inside `fleets/<application>/` in exactly two places —
 * `scafo deployment prune` and `scafo app lease` — and both read formats Celld
 * owns and changes between releases. A release nothing here has been run against
 * may have written those objects in shapes this cannot read, so the fleet's own
 * records are the gate: every node still answering must report a Celld release
 * `_celld-contract.ts` names, and an installation with nothing answering says
 * nothing at all, which is a refusal rather than a guess.
 */

import { ScafoError } from "../error.ts";
import { VERIFIED_CELLD_RELEASES, verifiedReleaseList } from "./_celld-contract.ts";
import type { RegistryContext } from "./context.ts";
import { isNodeAnswering, listNodeRecords } from "./nodes.ts";

export interface CelldReleaseGateOptions {
  /** The moment a node's last heartbeat is judged against. */
  now: Date;
  /** The command an operator typed, as its own refusal names it. */
  command: string;
}

/**
 * Refuses with `ScafoError("capability-missing")` unless every node of the
 * installation that is still answering reports a Celld release this build was
 * verified against.
 */
export async function assertVerifiedCelldRelease(
  ctx: RegistryContext,
  opts: CelldReleaseGateOptions,
): Promise<void> {
  /* Records of nodes that stopped answering are IGNORED, using the same
     liveness rule the version-skew gate uses. Nothing ever reaps a node record,
     so a machine retired two years ago would otherwise block every run of the
     installation forever on whatever it happened to be running. */
  const answering = (await listNodeRecords(ctx)).filter((record) =>
    isNodeAnswering(record, opts.now),
  );
  if (answering.length === 0) {
    throw releaseProblem(
      opts.command,
      "no node of this installation is answering, so nothing says which Celld release wrote " +
        "this bucket",
      "start a node, or wait for one to heartbeat, and run it again",
    );
  }

  for (const record of answering) {
    const celld = record.versions?.celld;
    if (celld === undefined) {
      throw releaseProblem(
        opts.command,
        `node "${record.id}" is answering and its record names no Celld version`,
        "restart that node on a build that records what it runs",
      );
    }
    if (!VERIFIED_CELLD_RELEASES.includes(celld)) {
      throw releaseProblem(
        opts.command,
        `node "${record.id}" is answering on celld ${celld}`,
        "run a scafo verified against that release",
      );
    }
  }
}

/** The release refusal, in the voice of the boot-time Celld floor. */
function releaseProblem(command: string, found: string, fix: string): ScafoError {
  return new ScafoError("capability-missing", "Celld release is not one this was verified on", {
    detail:
      `${found}; ${command} reads Celld's own bucket formats and this build was ` +
      `verified against ${verifiedReleaseList()} only, so nothing was planned or deleted — ${fix}`,
  });
}
