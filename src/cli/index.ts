#!/usr/bin/env node
/* The `scafo` binary: one executable for the node agent and its operator commands. */

import { defineCommand, runMain } from "citty";
import { readPackageVersion } from "./_utils.ts";
import { deploy } from "./commands/deploy.ts";
import { env } from "./commands/env.ts";
import { fleet } from "./commands/fleet.ts";
import { keygen } from "./commands/keygen.ts";
import { metrics } from "./commands/metrics.ts";
import { traces } from "./commands/traces.ts";
import { trust } from "./commands/trust.ts";
import { up } from "./commands/up.ts";
import { varset } from "./commands/varset.ts";
import { wg } from "./commands/wg.ts";

const main = defineCommand({
  meta: async () => ({
    name: "scafo",
    version: await readPackageVersion(),
    description: "Self-hosted serverless deployment platform for JS apps",
  }),
  subCommands: { up, fleet, keygen, deploy, env, varset, trust, metrics, traces, wg },
});

await runMain(main);
