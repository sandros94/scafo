/*
 * Internal: reading back what the names in a window of counters actually are.
 *
 * A counting node attributes a host through the routing it published, and falls
 * back to a PURE, REGISTRY-FREE host grammar for everything the routing does not
 * name. That grammar cannot tell a real application from a label a crawler
 * invented, because only the registry can. So the reader checks the counted
 * names against the registry's own listing.
 *
 * ONE LISTING, AND THAT IS THE BUDGET: never a record read, and never a name
 * nothing in the window counted.
 */

import { listApplications } from "../core/registry/applications.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import type { MetricsNaming } from "./_metrics.ts";

/**
 * What the registry holds about the applications a window named.
 *
 * `wanted` is what {@link applicationsCounted} answered; a name the registry
 * does not hold is left out, which is exactly what makes it read as unmatched
 * rather than as a row of its own.
 */
export async function readMetricsNaming(
  ctx: RegistryContext,
  wanted: readonly string[],
): Promise<MetricsNaming> {
  const held = new Set(await listApplications(ctx));
  return { applications: new Set(wanted.filter((name) => held.has(name))) };
}
