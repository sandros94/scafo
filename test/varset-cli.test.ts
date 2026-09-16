/*
 * `scafo varset` and `scafo env varset`: reading a variable file, the surface the
 * subcommands present, and every line they put on the terminal.
 */

import type { ArgsDef, CommandDef } from "citty";
import { describe, expect, it } from "vitest";
import { env } from "../src/cli/commands/env.ts";
import { varset } from "../src/cli/commands/varset.ts";
import {
  describeEnvironmentVarset,
  describeVarsetUse,
  describeVarsetWrite,
  formatVarsetVars,
  parseDotenv,
  readVarsetFlags,
} from "../src/cli/_varset.ts";
import { rejectsWith } from "./_helpers.ts";

const PROJECT = "shop";

/** The value every "did a variable leak" check scans for. */
const SECRET_MARKER = "hunter2-do-not-print";

/** Declared flags of one subcommand, by the name an operator types. */
function argsOf(command: CommandDef, name: string): ArgsDef {
  const subCommands = command.subCommands as Record<string, CommandDef>;
  const sub = subCommands[name];
  if (sub === undefined) throw new Error(`no "${name}" subcommand`);
  return sub.args as ArgsDef;
}

describe("reading a variable file", () => {
  it("takes one KEY=VALUE per line, skipping blank lines and comments", () => {
    const vars = parseDotenv(
      [
        "# the database",
        "",
        "DATABASE_URL=postgres://db.test/app",
        "   ",
        "  # indented comment",
        "  FEATURE_FLAGS = beta  ",
      ].join("\n"),
      ".env",
    );

    expect(vars).toEqual({
      DATABASE_URL: "postgres://db.test/app",
      FEATURE_FLAGS: "beta",
    });
  });

  it("keeps everything after the first = , quotes and all", () => {
    const vars = parseDotenv(
      ["DSN=postgres://user:p=ss@db.test/app?ssl=true", 'GREETING="hello world"', "EMPTY="].join(
        "\n",
      ),
      ".env",
    );

    /* No unquoting: what an operator wrote is what the process is given, so a
       value is never silently different from the file it came out of. */
    expect(vars).toEqual({
      DSN: "postgres://user:p=ss@db.test/app?ssl=true",
      GREETING: '"hello world"',
      EMPTY: "",
    });
  });

  it("reads a file whichever way its lines end", () => {
    expect(parseDotenv("A=1\r\nB=2\r\n", ".env")).toEqual({ A: "1", B: "2" });
  });

  it("refuses a line that is not a variable rather than guessing at it", async () => {
    const cases: [string, string][] = [
      ["DATABASE_URL", "is not KEY=VALUE"],
      ["export A=1", "usable variable name"],
      ["1A=1", "usable variable name"],
      ["A B=1", "usable variable name"],
      ["A=1\nA=2", "set twice"],
      /* Names a plain object inherits: refused as names, never reported as repeats. */
      ["__proto__=1", "usable variable name"],
      ["constructor=1", "usable variable name"],
    ];

    for (const [text, expected] of cases) {
      const error = await rejectsWith(
        () => Promise.resolve(parseDotenv(text, "/etc/scafo/app.env")),
        "invalid-input",
      );
      expect(error.detail, text).toContain(expected);
      /* Actionable: which file, which line, and what the dialect is. */
      expect(error.detail, text).toContain("/etc/scafo/app.env:");
    }
  });
});

describe("the surface the subcommands present", () => {
  it("manages varsets by name, per project", () => {
    expect(Object.keys(varset.subCommands as Record<string, CommandDef>).sort()).toEqual([
      "delete",
      "list",
      "set",
      "show",
    ]);

    const set = argsOf(varset, "set");
    expect(Object.keys(set)).toContain("name");
    expect(Object.keys(set)).toContain("file");
    /* A varset belongs to a project and is carried by whichever environments
       point at it, so neither an environment nor a key file is named here. */
    for (const gone of ["env", "public", "key-file"]) {
      expect(Object.keys(set), gone).not.toContain(gone);
    }
    expect(Object.keys(argsOf(varset, "show"))).toContain("reveal");
  });

  it("points an environment at one through `scafo env varset`", () => {
    expect(Object.keys(env.subCommands as Record<string, CommandDef>)).toContain("varset");

    const args = Object.keys(argsOf(env, "varset"));
    expect(args).toContain("name");
    expect(args).toContain("none");
  });
});

describe("what `scafo varset set` prints", () => {
  it("says what it holds, who carries it, and whether each has deployed it", () => {
    expect(
      describeVarsetWrite({
        project: PROJECT,
        name: "shared",
        variables: 3,
        environments: [
          { env: "production", carried: "current" },
          { env: "staging", carried: "stale" },
        ],
      }),
    ).toBe(
      `scafo: varset "shared" of "shop" holds 3 variables; used by production (deployed), ` +
        `staging (pending deploy) — takes effect at their next deploy`,
    );
  });

  it("reads an environment that has never deployed as pending too", () => {
    expect(
      describeVarsetWrite({
        project: PROJECT,
        name: "shared",
        variables: 1,
        environments: [{ env: "preview", carried: "never" }],
      }),
    ).toContain("used by preview (pending deploy)");
  });

  it("says so plainly when nothing carries it yet", () => {
    expect(
      describeVarsetWrite({ project: PROJECT, name: "spare", variables: 1, environments: [] }),
    ).toBe(`scafo: varset "spare" of "shop" holds 1 variable; no environment points at it yet`);
  });
});

describe("what `scafo varset show` prints", () => {
  const vars = { DATABASE_URL: SECRET_MARKER, FEATURE_FLAGS: "beta" };

  it("names the variables and nothing else, because this output is read over shoulders", () => {
    const printed = formatVarsetVars(vars);

    expect(printed).toBe("DATABASE_URL\nFEATURE_FLAGS");
    expect(printed).not.toContain(SECRET_MARKER);
  });

  it("prints the values only when they were asked for", () => {
    expect(formatVarsetVars(vars, { reveal: true })).toBe(
      `DATABASE_URL=${SECRET_MARKER}\nFEATURE_FLAGS=beta`,
    );
  });

  it("sorts by name, whichever order the file was written in", () => {
    expect(formatVarsetVars({ B: "2", A: "1" }, { reveal: true })).toBe("A=1\nB=2");
    expect(formatVarsetVars({})).toBe("");
  });
});

describe("what `scafo varset list` prints", () => {
  it("gives one line per varset: what it holds, who carries it, and who deployed it", () => {
    expect(
      describeVarsetUse({
        project: PROJECT,
        name: "shared",
        variables: 3,
        environments: [
          { env: "production", carried: "current" },
          { env: "staging", carried: "never" },
        ],
      }),
    ).toBe("shared: 3 variables, used by production (deployed), staging (pending deploy)");
    expect(
      describeVarsetUse({ project: PROJECT, name: "spare", variables: 1, environments: [] }),
    ).toBe("spare: 1 variable, used by no environment");
  });
});

describe("what `scafo env varset` prints", () => {
  const target = { project: PROJECT, env: "production" };

  it("names the varset and says when it lands", () => {
    expect(describeEnvironmentVarset(target, "shared")).toBe(
      `scafo: "shop/production" carries varset "shared"; it takes effect at the environment's ` +
        `next deploy`,
    );
  });

  it("says the same when the environment stops carrying one", () => {
    expect(describeEnvironmentVarset(target, null)).toBe(
      `scafo: "shop/production" carries no varset; it takes effect at the environment's ` +
        `next deploy`,
    );
  });
});

describe("the two ways `scafo env varset` can be told what to do", () => {
  it("takes exactly one of them", () => {
    expect(readVarsetFlags({ name: "shared", none: false })).toBe("shared");
    expect(readVarsetFlags({ name: undefined, none: true })).toBeNull();
  });

  it("refuses both at once, and neither at all", async () => {
    const both = await rejectsWith(
      () => Promise.resolve(readVarsetFlags({ name: "shared", none: true })),
      "invalid-input",
    );
    expect(both.detail).toContain("--none");

    /* Neither is not read as "--none": an accidental `scafo env varset` that
       dropped a varset would change what the next deploy carries. */
    const neither = await rejectsWith(
      () => Promise.resolve(readVarsetFlags({ name: undefined, none: false })),
      "invalid-input",
    );
    expect(neither.detail).toContain("--name");
  });
});
