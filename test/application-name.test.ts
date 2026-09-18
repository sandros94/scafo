/*
 * The one naming grammar: `--name`, optionally `--env`, and the application both
 * of them together address.
 *
 * `--env` is a client-side convenience and nothing more — the node is only ever
 * told `<name>-<env>` — so the rule lives in one helper, every command that
 * addresses an application declares the same pair of flags, and the help of the
 * binary teaches that pair and no other.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ArgsDef, CommandDef } from "citty";
import { describe, expect, it } from "vitest";
import { resolveApplication } from "../src/cli/_application.ts";
import { app } from "../src/cli/commands/app.ts";
import { deploy } from "../src/cli/commands/deploy.ts";
import { deployment } from "../src/cli/commands/deployment.ts";
import { metrics } from "../src/cli/commands/metrics.ts";
import { traces } from "../src/cli/commands/traces.ts";
import { trust } from "../src/cli/commands/trust.ts";
import { SLUG_MAX_LENGTH } from "../src/core/utils/slug.ts";
import { rejectsWith } from "./_helpers.ts";

/** The binary, run the way a terminal runs it. */
const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

describe("the application --name and --env address", () => {
  it("is the name itself when no env is given", () => {
    expect(resolveApplication({ name: "shop" })).toBe("shop");
    expect(resolveApplication({ name: "shop", env: undefined })).toBe("shop");
  });

  it("joins the two with a hyphen, exactly as naming the joined application would", () => {
    expect(resolveApplication({ name: "shop", env: "preview" })).toBe("shop-preview");
    /* The same application, addressed the other way: nothing downstream can tell
       these two invocations apart, which is the whole point of the flag. */
    expect(resolveApplication({ name: "shop-preview" })).toBe("shop-preview");
  });

  it.each([
    ["a name that is not one", { name: "Shop" }],
    ["an env that is not one", { name: "shop", env: "Pre View" }],
    ["an env that would double a hyphen", { name: "shop", env: "-preview" }],
  ])("holds each half to the rule a name follows, refusing %s", async (_what, flags) => {
    const error = await rejectsWith(
      () => Promise.resolve(resolveApplication(flags)),
      "invalid-slug",
    );

    expect(error.code).toBe("invalid-slug");
  });

  it("refuses a JOINED name that is no name, naming both parts that made it", async () => {
    const name = "s".repeat(SLUG_MAX_LENGTH - 4);
    const env = "preview";

    const error = await rejectsWith(
      () => Promise.resolve(resolveApplication({ name, env })),
      "invalid-slug",
    );

    /* Two things were typed and only one of them is likely to be the problem, so
       the refusal names both and the name they made together. */
    expect(error.detail).toContain(name);
    expect(error.detail).toContain(env);
    expect(error.detail).toContain(`${name}-${env}`);
    expect(error.detail).toContain(String(SLUG_MAX_LENGTH));
  });

  it("refuses an env with no name to append it to", async () => {
    const error = await rejectsWith(
      () => Promise.resolve(resolveApplication({ env: "preview" })),
      "invalid-input",
    );

    expect(error.detail).toContain("--name");
  });

  it("reads blank text as nothing given, and trims what is given", async () => {
    expect(resolveApplication({ name: "  shop  " })).toBe("shop");
    expect(resolveApplication({ name: "shop", env: "  preview  " })).toBe("shop-preview");
    /* An empty --env is an env nobody named, not an empty segment appended. */
    expect(resolveApplication({ name: "shop", env: "   " })).toBe("shop");

    await rejectsWith(() => Promise.resolve(resolveApplication({ name: "   " })), "invalid-input");
  });
});

/** Every command that acts on one application, as citty declares it. */
const ADDRESSING: Array<[name: string, args: ArgsDef]> = [
  ["scafo deploy", argsOf(deploy)],
  ["scafo deployment prune", subArgs(deployment, "prune")],
  ["scafo metrics", argsOf(metrics)],
  ["scafo traces", argsOf(traces)],
  ["scafo trust set", subArgs(trust, "set")],
  ["scafo trust show", subArgs(trust, "show")],
  ["scafo trust remove", subArgs(trust, "remove")],
  ...[
    "show",
    "block",
    "unblock",
    "label",
    "retire",
    "unretire",
    "selector",
    "replicas",
    "delete",
  ].map((name): [string, ArgsDef] => [`scafo app ${name}`, subArgs(app, name)]),
];

describe("which flags a command that addresses an application takes", () => {
  it.each(ADDRESSING)("%s takes --name and --env, and no other way in", (_name, args) => {
    expect(Object.keys(args)).toContain("name");
    expect(Object.keys(args)).toContain("env");
    expect(Object.keys(args)).not.toContain("project");
  });

  it("leaves both off the one command that addresses no single application", () => {
    /* `scafo app list` answers for everything the key reaches, so a name would
       be a filter for a listing that is already scoped. */
    expect(Object.keys(subArgs(app, "list"))).not.toContain("name");
  });
});

describe("what the binary's help teaches", () => {
  it.each([
    ["scafo", []],
    ["scafo app", ["app"]],
    ["scafo deploy", ["deploy"]],
  ])("%s renders, and names neither a project nor an env command", (_name, argv) => {
    const rendered = help(argv);

    expect(rendered.length).toBeGreaterThan(0);
    /* The one surviving sense of the word is the directory being deployed. */
    expect(rendered.replaceAll("project directory", "")).not.toContain("project");
    expect(rendered).not.toContain("scafo env");
  });
});

/** What `scafo <argv> --help` puts on the terminal, asked for without colour. */
function help(argv: string[]): string {
  const run = spawnSync(process.execPath, [CLI, ...argv, "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

  expect(run.status, run.stderr).toBe(0);
  return `${run.stdout}${run.stderr}`;
}

function argsOf(command: CommandDef): ArgsDef {
  return command.args as ArgsDef;
}

function subArgs(command: CommandDef, name: string): ArgsDef {
  return argsOf((command.subCommands as Record<string, CommandDef>)[name]);
}
