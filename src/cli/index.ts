#!/usr/bin/env node
/* The `scafo` binary: one executable for the node daemon and its operator commands. */

import { defineCommand, runMain } from "citty";
import { readPackageVersion } from "./_utils.ts";
import { build } from "./commands/build.ts";
import { deploy } from "./commands/deploy.ts";
import { env } from "./commands/env.ts";
import { fleet } from "./commands/fleet.ts";
import { health } from "./commands/health.ts";
import { metrics } from "./commands/metrics.ts";
import { keygenAlias, operator } from "./commands/operator.ts";
import { project } from "./commands/project.ts";
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
   * FIVE NOUNS AND THEN THE WORK. `sail` is what a machine does; `remote` is
   * where an operator can reach and who they are there; `operator` is the
   * people; `fleet` is the machines of one installation; `project` is the things
   * it hosts. Everything after them acts on what is deployed.
   *
   * `health` comes straight after `sail` because it is the other half of it:
   * what a machine does, and whether it is doing it. It is what the image's
   * HEALTHCHECK runs.
   *
   * `up` and `keygen` are what two of these were called before the rename. They
   * are hidden, they say so once, and they go at launch.
   */
  subCommands: {
    sail,
    health,
    remote,
    operator,
    fleet,
    project,
    deploy,
    env,
    varset,
    build,
    trust,
    metrics,
    traces,
    wg,
    up,
    keygen: keygenAlias,
  },
});

await runMain(main);
