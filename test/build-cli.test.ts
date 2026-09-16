/*
 * `scafo build prune`: the surface it presents, what it refuses before it reads
 * a bucket, and every line it puts on the terminal.
 */

import type { ArgsDef, CommandDef } from "citty";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  build,
  describePrune,
  parseOlderThan,
  PRUNE_UNSTABLE_WHY,
  readPruneFlags,
} from "../src/cli/commands/build.ts";
import { warnUnstable } from "../src/cli/_warn.ts";
import type { Publication, PrunePlan } from "../src/core/registry/prune.ts";
import { rejectsWith } from "./_helpers.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Declared flags of one subcommand, by the name an operator types. */
function argsOf(command: CommandDef, name: string): ArgsDef {
  const subCommands = command.subCommands as Record<string, CommandDef>;
  const sub = subCommands[name];
  if (sub === undefined) throw new Error(`no "${name}" subcommand`);
  return sub.args as ArgsDef;
}

describe("the surface `scafo build` presents", () => {
  it("prunes an environment's publications, and takes the bucket the way every other command does", () => {
    expect(Object.keys(build.subCommands as Record<string, CommandDef>)).toEqual(["prune"]);

    const args = Object.keys(argsOf(build, "prune"));
    for (const flag of ["project", "env", "keep", "older-than", "dry-run"]) {
      expect(args, flag).toContain(flag);
    }
    for (const flag of ["endpoint", "region", "bucket", "prefix", "access-key", "secret-key"]) {
      expect(args, flag).toContain(flag);
    }
  });

  it("says in its own help that the shared asset blobs are left alone", () => {
    const prune = (build.subCommands as Record<string, CommandDef>).prune;
    const description = (prune.meta as { description?: string }).description ?? "";

    expect(description).toContain("deploy-blobs/");
    expect(description.toLowerCase()).toContain("left in place");
  });

  it("warns that it follows upstream before it does anything", () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    warnUnstable("scafo build prune", PRUNE_UNSTABLE_WHY);

    expect(lines).toEqual([
      `scafo: warning: "scafo build prune" is subject to change: Celld may grow a native ` +
        `deployment lifecycle (denoland/celld#181), and this command follows upstream when it does`,
    ]);
  });
});

describe("reading a duration", () => {
  it("takes days, hours, minutes, and plain seconds", () => {
    expect(parseOlderThan("30d")).toBe(30 * DAY_MS);
    expect(parseOlderThan("12h")).toBe(12 * HOUR_MS);
    expect(parseOlderThan("45m")).toBe(45 * 60_000);
    expect(parseOlderThan("3600s")).toBe(HOUR_MS);
    expect(parseOlderThan("3600")).toBe(HOUR_MS);
  });

  it.each(["1w", "abc", "1.5h", "-30d", "30 d", "", "0", "0s", "d"])(
    "refuses %j rather than guessing at it",
    async (value) => {
      const error = await rejectsWith(
        () => Promise.resolve(parseOlderThan(value)),
        "invalid-input",
      );
      expect(error.message).toContain("--older-than");
      expect(error.detail).toContain("30d");
    },
  );
});

describe("reading the flags", () => {
  const target = { project: "shop", env: "production" };

  it("keeps three publications, deletes for real, and reads no window by default", () => {
    expect(readPruneFlags({ ...target })).toEqual({
      project: "shop",
      env: "production",
      keep: 3,
      dryRun: false,
    });
  });

  it("takes either spelling of a hyphenated flag, because the parser hands over both", () => {
    expect(readPruneFlags({ ...target, "older-than": "30d", "dry-run": true })).toEqual({
      project: "shop",
      env: "production",
      keep: 3,
      olderThan: { text: "30d", ms: 30 * DAY_MS },
      dryRun: true,
    });
    expect(readPruneFlags({ ...target, olderThan: "12h", dryRun: true })).toEqual({
      project: "shop",
      env: "production",
      keep: 3,
      olderThan: { text: "12h", ms: 12 * HOUR_MS },
      dryRun: true,
    });
  });

  it("takes a keep of zero, which leaves only what a pointer names", () => {
    expect(readPruneFlags({ ...target, keep: "0" }).keep).toBe(0);
  });

  it.each(["-1", "1.5", "three", "", " "])("refuses %j as a keep count", async (keep) => {
    const error = await rejectsWith(
      () => Promise.resolve(readPruneFlags({ ...target, keep })),
      "invalid-input",
    );
    expect(error.message).toContain("--keep");
  });

  it.each(["project", "env"])("refuses to run without --%s", async (missing) => {
    const flags: Record<string, unknown> = { ...target };
    delete flags[missing];

    const error = await rejectsWith(() => Promise.resolve(readPruneFlags(flags)), "invalid-input");
    expect(error.detail).toContain(`--${missing}`);
  });
});

describe("what the command prints", () => {
  it("gives a line per publication, says why each was kept, and counts what went", () => {
    expect(describePrune({ plan: PLAN, keep: 3, olderThan: "12h" })).toEqual([
      `keep app/dddd4444: current, the fleet's selector points at it`,
      `keep app/cccc3333: within the newest 3 publications`,
      `keep app/bbbb2222: younger than 12h`,
      `delete app/aaaa1111: 2 objects and its build record`,
      `delete worker/ffff6666: 1 object and no build record`,
      `scafo: pruned 2 publications (3 objects, 1 build record) of "shop/production", kept 3; ` +
        `shared asset blobs under deploy-blobs/ are left in place`,
    ]);
  });

  it("says what would go, and only that, when nothing is to be deleted yet", () => {
    const lines = describePrune({ plan: PLAN, keep: 3, olderThan: "12h", dryRun: true });

    expect(lines.filter((line) => line.startsWith("would delete "))).toEqual([
      `would delete app/aaaa1111: 2 objects and its build record`,
      `would delete worker/ffff6666: 1 object and no build record`,
    ]);
    expect(lines.at(-1)).toBe(
      `scafo: would prune 2 publications (3 objects, 1 build record) of "shop/production", ` +
        `kept 3; shared asset blobs under deploy-blobs/ are left in place`,
    );
  });

  it("says plainly when there was nothing to prune", () => {
    const lines = describePrune({ plan: { ...PLAN, delete: [] }, keep: 3 });

    expect(lines.at(-1)).toBe(
      `scafo: nothing to prune in "shop/production", kept 3; shared asset blobs under ` +
        `deploy-blobs/ are left in place`,
    );
  });
});

/** One plan of each kept reason and of both kinds of doomed publication. */
const PLAN: PrunePlan = {
  project: "shop",
  env: "production",
  current: ["dddd4444"],
  keep: [
    { ...publication("app", "dddd4444", { record: true }), reason: "current" },
    { ...publication("app", "cccc3333", { record: true }), reason: "within-keep" },
    { ...publication("app", "bbbb2222", { record: true }), reason: "within-age" },
  ],
  delete: [
    publication("app", "aaaa1111", { record: true }),
    publication("worker", "ffff6666", { objects: 1 }),
  ],
};

function publication(
  script: string,
  version: string,
  opts: { record?: boolean; objects?: number },
): Publication {
  const prefix = `fleets/shop/production/deploy/${script}/${version}/`;
  return {
    script,
    version,
    prefix,
    keys: Array.from(
      { length: opts.objects ?? 2 },
      (_unused, index) => `${prefix}file-${String(index)}.js`,
    ),
    ...(opts.record === true ? { buildKey: `_scafo/projects/shop/builds/${version}.json` } : {}),
  };
}
