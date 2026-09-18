/* Whether an application's Celld fleet is already being served by another build. */

import { ScafoError } from "../error.ts";
import { isNodeAnswering } from "../registry/nodes.ts";
import type { NodeRecord } from "../types/registry.ts";

/** One other node holding the application, and the Celld its record reports. */
export interface VersionSkew {
  nodeId: string;
  /** Undefined when the record names no versions at all. */
  celld: string | undefined;
}

export interface VersionSkewQuery {
  /** The application, as it is keyed in a node's `serving`. */
  application: string;
  /** The Celld this node booted with. */
  celld: string;
  /** This node's id; its own record says what it booted with and is never compared. */
  selfId: string;
  now: Date;
  /** Liveness window; defaults to the registry's own. */
  windowMs?: number;
}

/**
 * Every other node still answering that serves `application` on a Celld other
 * than `celld`, in node order. Empty means this node may serve the application.
 *
 * ONE APPLICATION IS ONE CELLD FLEET, AND A FLEET TAKES ONE VERSION. A newer
 * binary upgrades the fleet's bucket format as it starts, and refuses to while
 * an older node still holds a lease in it; an older binary writing after that
 * upgrade corrupts what the newer one wrote. Neither failure is one scafo can
 * repair afterwards, so the pair is never allowed to exist: a node checks who
 * else holds the application before it starts a process for it or accepts a
 * deploy into it, and an upgrade stops every node of the installation first.
 *
 * A RECORD WITH NO VERSIONS COUNTS AS DIFFERENT. It was written by a build from
 * before the field existed, which makes it older than anything that reports one
 * — reading it as "probably the same" is the one guess with a corrupt bucket on
 * the other side of it.
 *
 * A DRAINING NODE STILL COUNTS while it is answering: it is on its way out, and
 * until it is gone its process still holds a lease in the fleet. A node outside
 * the liveness window does not — nothing it says is current, and an installation
 * could not be upgraded at all if a machine that is never coming back could
 * hold every application it once served.
 */
export function findVersionSkew(nodes: NodeRecord[], opts: VersionSkewQuery): VersionSkew[] {
  const window = opts.windowMs === undefined ? undefined : { windowMs: opts.windowMs };
  const found: VersionSkew[] = [];

  for (const record of nodes) {
    if (record.id === opts.selfId) continue;
    if (record.serving?.[opts.application] === undefined) continue;
    if (!isNodeAnswering(record, opts.now, window)) continue;

    const celld = record.versions?.celld;
    if (celld === opts.celld) continue;
    found.push({ nodeId: record.id, celld });
  }

  return found.sort((a, b) => (a.nodeId === b.nodeId ? 0 : a.nodeId < b.nodeId ? -1 : 1));
}

/** What a node reports for a record that names no version of its own. */
const UNREPORTED = "unreported";

/**
 * The refusal {@link findVersionSkew} earns, naming every node that has to stop
 * before this one can serve the application.
 *
 * Every name is in it because the operator's next move is to stop those
 * machines, and a refusal naming one of three would be followed by the same
 * refusal twice more.
 */
export function versionSkewError(
  skew: VersionSkew[],
  about: { application: string; celld: string },
): ScafoError {
  const others = skew
    .map((entry) => `${entry.nodeId} (celld ${entry.celld ?? UNREPORTED})`)
    .join(", ");

  return new ScafoError("version-skew", "Celld versions differ across the fleet", {
    detail:
      `this node runs celld ${about.celld}, and "${about.application}" is held elsewhere by ` +
      `${others}; one application is one Celld fleet and a fleet takes one version, so stop ` +
      `every node of this installation before starting the new binaries`,
  });
}
