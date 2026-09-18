/*
 * `scafo deployment prune`: the surface it presents, what it refuses before it
 * reads a bucket, and every line it puts on the terminal.
 */

import type { ArgsDef, CommandDef } from "citty";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGE_GATE_LIFTED_WARNING,
  deployment,
  describePrune,
  parseOlderThan,
  PRUNE_UNSTABLE_WHY,
  type PruneDialog,
  readPruneFlags,
  runPruneDialog,
  warnAgeGateLifted,
} from "../src/cli/commands/deployment.ts";
import { warnUnstable } from "../src/cli/_warn.ts";
import type { PrunePlan, StoredDeployment } from "../src/core/registry/prune.ts";
import { VERIFIED_CELLD_RELEASES } from "../src/core/registry/_celld-contract.ts";
import { rejectsWith } from "./_helpers.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** The description one subcommand presents in `--help`. */
function argsDescription(command: CommandDef, name: string): string {
  const subCommands = command.subCommands as Record<string, CommandDef>;
  const sub = subCommands[name];
  if (sub === undefined) throw new Error(`no "${name}" subcommand`);
  return (sub.meta as { description: string }).description;
}

/** Declared flags of one subcommand, by the name an operator types. */
function argsOf(command: CommandDef, name: string): ArgsDef {
  const subCommands = command.subCommands as Record<string, CommandDef>;
  const sub = subCommands[name];
  if (sub === undefined) throw new Error(`no "${name}" subcommand`);
  return sub.args as ArgsDef;
}

describe("the surface `scafo deployment` presents", () => {
  it("prunes an environment's deployments, and takes the bucket the way every other command does", () => {
    expect(Object.keys(deployment.subCommands as Record<string, CommandDef>)).toEqual(["prune"]);

    const args = Object.keys(argsOf(deployment, "prune"));
    for (const flag of ["project", "env", "keep", "older-than", "dry-run", "yes"]) {
      expect(args, flag).toContain(flag);
    }
    for (const flag of ["endpoint", "region", "bucket", "prefix", "access-key", "secret-key"]) {
      expect(args, flag).toContain(flag);
    }
  });

  it("says in its own help what becomes of the shared asset blobs", () => {
    const prune = (deployment.subCommands as Record<string, CommandDef>).prune;
    const description = (prune.meta as { description?: string }).description ?? "";

    expect(description).toContain("deploy-blobs/");
    expect(description).toContain("no kept deployment references");
    expect(description).toContain("older than the window");
  });

  it("states both defaults in its own help, and that a zero lifts either gate", () => {
    const args = argsOf(deployment, "prune") as Record<string, { description?: string }>;
    const keep = args.keep?.description ?? "";
    const window = args["older-than"]?.description ?? "";

    expect(keep).toContain("10");
    expect(keep).toContain("0");
    expect(window).toContain("24h");
    expect(window).toContain("0");
    expect(args.yes?.description ?? "").toContain("asking");
  });

  it("warns that lifting the age gate can delete a deploy that is happening", () => {
    const lines = warnings(() => {
      warnAgeGateLifted(0);
    });

    expect(lines).toEqual([
      `scafo: warning: "--older-than 0" lifts the age gate: a deploy in flight uploads its ` +
        `files before it is visible, and pruning now can delete one that is happening; do not ` +
        `prune while anyone deploys`,
    ]);
    expect(lines[0]).toContain(AGE_GATE_LIFTED_WARNING);
  });

  it("says nothing about the age gate when there is a window at all", () => {
    expect(
      warnings(() => {
        warnAgeGateLifted(DAY_MS);
        warnAgeGateLifted(1);
      }),
    ).toEqual([]);
  });

  it("is silenced by the one switch that silences every warning", () => {
    vi.stubEnv("SCAFO_SILENCE_WARNINGS", "1");

    expect(
      warnings(() => {
        warnAgeGateLifted(0);
      }),
    ).toEqual([]);
  });

  it("names the Celld releases it was verified against, from the constant that pins them", () => {
    const description = argsDescription(deployment, "prune");

    for (const release of VERIFIED_CELLD_RELEASES) {
      expect(description, "the help an operator reads").toContain(release);
      expect(PRUNE_UNSTABLE_WHY, "the warning every run prints").toContain(release);
    }
  });

  it("warns that it follows upstream before it does anything", () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    warnUnstable("scafo deployment prune", PRUNE_UNSTABLE_WHY);

    expect(lines).toEqual([
      `scafo: warning: "scafo deployment prune" is subject to change: ${PRUNE_UNSTABLE_WHY}`,
    ]);
    expect(PRUNE_UNSTABLE_WHY).toContain("denoland/celld#181");
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

  it("takes a zero, which is the age gate lifted rather than a window", () => {
    expect(parseOlderThan("0")).toBe(0);
    expect(parseOlderThan("0s")).toBe(0);
  });

  it.each(["1w", "abc", "1.5h", "-30d", "30 d", "", "d"])(
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

  it("keeps ten deployments, deletes nothing younger than a day, and asks first by default", () => {
    expect(readPruneFlags({ ...target })).toEqual({
      project: "shop",
      env: "production",
      keep: 10,
      olderThan: { text: "24h", ms: DAY_MS },
      dryRun: false,
      yes: false,
    });
  });

  it("takes either spelling of a hyphenated flag, because the parser hands over both", () => {
    expect(readPruneFlags({ ...target, "older-than": "30d", "dry-run": true })).toEqual({
      project: "shop",
      env: "production",
      keep: 10,
      olderThan: { text: "30d", ms: 30 * DAY_MS },
      dryRun: true,
      yes: false,
    });
    expect(readPruneFlags({ ...target, olderThan: "12h", dryRun: true })).toEqual({
      project: "shop",
      env: "production",
      keep: 10,
      olderThan: { text: "12h", ms: 12 * HOUR_MS },
      dryRun: true,
      yes: false,
    });
  });

  it("takes a keep of zero, which leaves only what a pointer names", () => {
    expect(readPruneFlags({ ...target, keep: "0" }).keep).toBe(0);
  });

  it("takes a window of zero, which deletes whatever the keep count did not spare", () => {
    expect(readPruneFlags({ ...target, "older-than": "0" }).olderThan).toEqual({
      text: "0",
      ms: 0,
    });
    expect(readPruneFlags({ ...target, "older-than": "0s" }).olderThan).toEqual({
      text: "0s",
      ms: 0,
    });
  });

  it("takes --yes, which answers the question the command would have asked", () => {
    expect(readPruneFlags({ ...target, yes: true }).yes).toBe(true);
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
  it("gives a line per deployment and counts what went, for a run, a dry run, and an empty one", () => {
    expect(describePrune({ plan: PLAN, keep: 3, olderThan: "12h" })).toEqual([
      `keep app/dddd4444: current, the fleet's selector points at it`,
      `keep app/cccc3333: within the newest 3 deployments`,
      `keep app/bbbb2222: younger than 12h`,
      `delete app/aaaa1111: 2 objects and its deployment record`,
      `delete worker/ffff6666: 1 object and no deployment record`,
      `delete 4 asset blobs no kept deployment references`,
      `scafo: pruned 2 deployments (3 objects, 1 deployment record, 4 asset blobs) of ` +
        `"shop/production", kept 3; ${BLOBS_SENTENCE}`,
    ]);

    /* A dry run says what WOULD go, and only that. */
    const dry = describePrune({ plan: PLAN, keep: 3, olderThan: "12h", dryRun: true });

    expect(dry.filter((line) => line.startsWith("would delete "))).toEqual([
      `would delete app/aaaa1111: 2 objects and its deployment record`,
      `would delete worker/ffff6666: 1 object and no deployment record`,
      `would delete 4 asset blobs no kept deployment references`,
    ]);
    expect(dry.at(-1)).toBe(
      `scafo: would prune 2 deployments (3 objects, 1 deployment record, 4 asset blobs) of ` +
        `"shop/production", kept 3; ${BLOBS_SENTENCE}`,
    );

    const nothing = describePrune({
      plan: { ...PLAN, delete: [], blobs: { keep: 12, delete: [] } },
      keep: 3,
      olderThan: "12h",
    });

    expect(nothing.slice(-2)).toEqual([
      `keep 12 asset blobs, referenced or younger than 12h`,
      `scafo: nothing to prune in "shop/production", kept 3; ${BLOBS_SENTENCE}`,
    ]);
  });

  it("says nothing of the blobs in an environment that has none", () => {
    const lines = describePrune({
      plan: { ...PLAN, delete: [], blobs: { keep: 0, delete: [] } },
      keep: 3,
      olderThan: "12h",
    });

    /* The summary always names the rule; the plan above it says nothing. */
    expect(lines.slice(0, -1).filter((line) => line.includes("asset blob"))).toEqual([]);
  });

  it("counts the blobs it collects beside a deployment nothing selected", () => {
    const lines = describePrune({
      plan: { ...PLAN, delete: [], blobs: { keep: 8, delete: BLOB_KEYS } },
      keep: 3,
      olderThan: "12h",
    });

    expect(lines.at(-2)).toBe(`delete 4 asset blobs no kept deployment references`);
    expect(lines.at(-1)).toBe(
      `scafo: pruned 0 deployments (0 objects, 0 deployment records, 4 asset blobs) of ` +
        `"shop/production", kept 3; ${BLOBS_SENTENCE}`,
    );
  });
});

describe("asking before anything is deleted", () => {
  it("prints the plan first, asks once, and prunes when the answer is yes", async () => {
    const run = session({ answer: "y" });

    await run.go();

    expect(run.asked).toEqual([
      `Delete 2 deployments (3 objects) and 4 asset blobs of "shop/production"? [y/N] `,
    ]);
    /* Every line but the summary was already on the terminal when the question
       was put: an operator answers having read what would go. */
    expect(run.saidWhenAsked()).toBe(6);
    expect(run.pruned()).toBe(1);
    expect(run.said).toEqual(describePrune({ plan: PLAN, keep: 10, olderThan: "24h" }));
  });

  it.each(["y", "Y", "yes", "YES", " yes "])("takes %j for an answer", async (answer) => {
    const run = session({ answer });

    await run.go();

    expect(run.pruned()).toBe(1);
    expect(run.said).not.toContain("scafo: nothing deleted");
  });

  it.each(["n", "N", "", "  ", "no", "yeah", "delete"])(
    "deletes nothing when the answer is %j",
    async (answer) => {
      const run = session({ answer });

      await run.go();

      expect(run.pruned()).toBe(0);
      expect(run.said.at(-1)).toBe("scafo: nothing deleted");
      /* The summary is a report of what went, and nothing went. */
      expect(run.said.filter((line) => line.startsWith("scafo: pruned"))).toEqual([]);
    },
  );

  it("asks nothing when --yes already answered it", async () => {
    const run = session({ yes: true });

    await run.go();

    expect(run.asked).toEqual([]);
    expect(run.pruned()).toBe(1);
    expect(run.said.at(-1)).toContain("scafo: pruned 2 deployments");
  });

  it("refuses to delete when there is no terminal to ask at and nothing said --yes", async () => {
    const run = session({ isTTY: false });

    const error = await rejectsWith(() => run.go(), "invalid-input");

    expect(error.detail).toContain("--yes");
    expect(run.asked).toEqual([]);
    expect(run.pruned()).toBe(0);
  });

  it("deletes without asking when there is no terminal but --yes was given", async () => {
    const run = session({ isTTY: false, yes: true });

    await run.go();

    expect(run.asked).toEqual([]);
    expect(run.pruned()).toBe(1);
  });

  it("asks nothing on a dry run, and deletes nothing", async () => {
    const run = session({ dryRun: true, isTTY: false });

    await run.go();

    expect(run.asked).toEqual([]);
    expect(run.pruned()).toBe(0);
    expect(run.said.at(-1)).toContain("scafo: would prune 2 deployments");
  });

  it("asks nothing when the plan names nothing to delete", async () => {
    const run = session({ plan: { ...PLAN, delete: [], blobs: { keep: 12, delete: [] } } });

    await run.go();

    expect(run.asked).toEqual([]);
    expect(run.pruned()).toBe(0);
    expect(run.said.at(-1)).toContain("scafo: nothing to prune");
  });

  it("asks about the blobs alone when they are all the plan selected", async () => {
    const run = session({
      answer: "y",
      plan: { ...PLAN, delete: [], blobs: { keep: 8, delete: BLOB_KEYS } },
    });

    await run.go();

    expect(run.asked).toEqual([`Delete 4 asset blobs of "shop/production"? [y/N] `]);
    expect(run.pruned()).toBe(1);
  });
});

/** Every `scafo: warning: …` line `act` puts on stderr. */
function warnings(act: () => void): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  act();
  return lines;
}

/** One run of the dialog with everything that touches a terminal or a bucket recorded. */
function session(
  opts: {
    answer?: string;
    yes?: boolean;
    isTTY?: boolean;
    dryRun?: boolean;
    plan?: PrunePlan;
  } = {},
): {
  said: string[];
  asked: string[];
  pruned: () => number;
  saidWhenAsked: () => number;
  go: () => Promise<void>;
} {
  const said: string[] = [];
  const asked: string[] = [];
  let saidWhenAsked = -1;
  let pruned = 0;

  const dialog: PruneDialog = {
    report: {
      plan: opts.plan ?? PLAN,
      keep: 10,
      olderThan: "24h",
      ...(opts.dryRun === true ? { dryRun: true } : {}),
    },
    yes: opts.yes === true,
    isTTY: opts.isTTY ?? true,
    ask: (question: string): Promise<string> => {
      asked.push(question);
      saidWhenAsked = said.length;
      return Promise.resolve(opts.answer ?? "");
    },
    prune: (): Promise<void> => {
      pruned += 1;
      return Promise.resolve();
    },
    say: (line: string): void => {
      said.push(line);
    },
  };

  return {
    said,
    asked,
    pruned: (): number => pruned,
    saidWhenAsked: (): number => saidWhenAsked,
    go: (): Promise<void> => runPruneDialog(dialog),
  };
}

/** Four blobs no deployment that stays references, as Celld keys them. */
const BLOB_KEYS = ["0a", "1b", "2c", "3d"].map(
  (fanout) => `fleets/shop/production/deploy-blobs/assets/sha256/${fanout}/${fanout.repeat(32)}`,
);

/** One plan of each kept reason and of both kinds of doomed deployment. */
const PLAN: PrunePlan = {
  project: "shop",
  env: "production",
  current: ["dddd4444"],
  keep: [
    { ...storedDeployment("app", "dddd4444", { record: true }), reason: "current" },
    { ...storedDeployment("app", "cccc3333", { record: true }), reason: "within-keep" },
    { ...storedDeployment("app", "bbbb2222", { record: true }), reason: "within-age" },
  ],
  delete: [
    storedDeployment("app", "aaaa1111", { record: true }),
    storedDeployment("worker", "ffff6666", { objects: 1 }),
  ],
  blobs: { keep: 12, delete: BLOB_KEYS },
};

/** The sentence every summary ends on, and the help says too. */
const BLOBS_SENTENCE =
  `shared asset blobs under deploy-blobs/ that no kept deployment references go once they are ` +
  `older than the window`;

function storedDeployment(
  script: string,
  version: string,
  opts: { record?: boolean; objects?: number },
): StoredDeployment {
  const prefix = `fleets/shop/production/deploy/${script}/${version}/`;
  return {
    script,
    version,
    prefix,
    keys: Array.from(
      { length: opts.objects ?? 2 },
      (_unused, index) => `${prefix}file-${String(index)}.js`,
    ),
    ...(opts.record === true
      ? { recordKey: `_scafo/projects/shop/deployments/${version}.json` }
      : {}),
  };
}
