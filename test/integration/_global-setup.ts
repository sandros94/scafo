/*
 * Builds `dist/` ONCE for a run of the container suites, before any of them starts.
 *
 * Every suite runs the built CLI and bind-mounts the worktree, read-only, into
 * its node containers. A suite that built for itself would rewrite `dist/` under
 * a daemon another suite is running, so none does: what they share is built here
 * and only read afterwards. A run with no container suite enabled builds nothing.
 */

import { REPO_ROOT, run } from "./_harness.ts";

export default async function setup(): Promise<void> {
  if (process.env.SCAFO_E2E !== "1" && process.env.SCAFO_K3S_E2E !== "1") return;

  const built = await run("pnpm", ["build"], REPO_ROOT, process.env as Record<string, string>);
  if (built.code !== 0) throw new Error(`"pnpm build" failed:\n${built.output}`);
}
