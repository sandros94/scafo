/* Internal: the node-credit flags shared by both ways a machine is registered. */

import type { ArgsDef } from "citty";

/** Credit inputs `scafo sail` and `scafo wg init` must parse identically. */
export const creditArgs: ArgsDef = {
  "memory-fraction": {
    type: "string",
    description: "Share of node memory allocatable to runtime and deploy credit (default 0.8)",
  },
  "daemon-overhead-mb": {
    type: "string",
    description: "MiB reserved for the node daemon before credit allocation (default 128)",
  },
  "runtime-credit-mb": {
    type: "string",
    description: "MiB reserved by one serving runtime and its protected surge (default 512)",
  },
  "deploy-credit-mb": {
    type: "string",
    description: "MiB reserved by one active deploy until artifact cleanup (default 1024)",
  },
};
