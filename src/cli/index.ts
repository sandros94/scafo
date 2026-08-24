#!/usr/bin/env node
/* The `scafo` binary: one executable for the node daemon and its operator commands. */

import { defineCommand, runMain } from "citty";
import { readPackageVersion } from "./_utils.ts";
import { deploy } from "./commands/deploy.ts";
import { env } from "./commands/env.ts";
import { fleet } from "./commands/fleet.ts";
import { metrics } from "./commands/metrics.ts";
import { keygenAlias, operator } from "./commands/operator.ts";
import { remote } from "./commands/remote.ts";
import { sail, up } from "./commands/sail.ts";
import { traces } from "./commands/traces.ts";
import { trust } from "./commands/trust.ts";
import { varset } from "./commands/varset.ts";
import { wg } from "./commands/wg.ts";

const main = defineCommand({
  meta: async () => ({
    name: "scafo",
    version: await readPackageVersion(),
    description: "Self-hosted serverless deployment platform for JS apps",
  }),
  /*
   * THREE NOUNS AND THEN THE WORK. `sail` is what a machine does; `remote` is
   * where an operator can reach and who they are there; `operator` is the
   * people; `fleet` is the machines of one installation. Everything after them
   * acts on what is deployed.
   *
   * `up` and `keygen` are what two of these were called before the rename. They
   * are hidden, they say so once, and they go at launch.
   */
  subCommands: {
    sail,
    remote,
    operator,
    fleet,
    deploy,
    env,
    varset,
    trust,
    metrics,
    traces,
    wg,
    up,
    keygen: keygenAlias,
  },
});

await runMain(main);
