#!/usr/bin/env node
/* The `scalo` binary: one executable for the node agent and its operator commands. */

import { defineCommand, runMain } from "citty";
import { readPackageVersion } from "./_utils.ts";
import { deploy } from "./commands/deploy.ts";
import { keygen } from "./commands/keygen.ts";
import { up } from "./commands/up.ts";

const main = defineCommand({
  meta: async () => ({
    name: "scalo",
    version: await readPackageVersion(),
    description: "Self-hosted serverless deployment platform for JS apps",
  }),
  subCommands: { up, keygen, deploy },
});

await runMain(main);
