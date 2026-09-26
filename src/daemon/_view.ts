/* Internal: the one registry view every loop on a node shares. */

import {
  createRegistryView,
  DEFAULT_NODE_REFRESH_INTERVAL_MS,
  DEFAULT_REGISTRY_RESYNC_MS,
  type RegistryView,
} from "../core/registry/view.ts";
import type { DaemonContext } from "./app.ts";

/**
 * This node's registry view, built on first use and kept on the daemon.
 *
 * ONE PER NODE, because the whole saving is in sharing it: the reconcile loop,
 * the coordinator and deploy intake all want the same three kinds of record, and
 * three views would read the same listings three times and disagree about what
 * they found. A caller that needs one of its own — with other intervals, or over
 * another clock — puts it on {@link DaemonContext.view} before anything asks,
 * and this never replaces one that is already there.
 */
export function registryView(daemon: DaemonContext): RegistryView {
  daemon.view ??= createRegistryView(daemon.registry, {
    resyncIntervalMs: daemon.config.registry?.resyncIntervalMs ?? DEFAULT_REGISTRY_RESYNC_MS,
    nodeRefreshIntervalMs:
      daemon.config.registry?.nodeRefreshIntervalMs ?? DEFAULT_NODE_REFRESH_INTERVAL_MS,
  });
  return daemon.view;
}
