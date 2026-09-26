/*
 * `scafo app lease`: the surface it presents, the warning every run carries, the
 * lines it puts on the terminal, and the question it refuses to skip.
 */

import type { ArgsDef, CommandDef } from "citty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/cli/commands/app.ts";
import {
  describeLeaseDrop,
  describeLeases,
  LEASE_UNSTABLE_WHY,
  type LeaseDropDialog,
  runLeaseDropDialog,
} from "../src/cli/_app-lease.ts";
import { warnUnstable } from "../src/cli/_warn.ts";
import { VERIFIED_CELLD_RELEASES } from "../src/core/registry/_celld-contract.ts";
import type { CelldLeaseDrop, CelldLeaseReading } from "../src/core/registry/celld-lease.ts";
import { rejectsWith } from "./_helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const KEY = "fleets/shop-production/nodes/node-a.json";

describe("the surface `scafo app lease` presents", () => {
  it("is a subcommand of app, with a look and a drop, and takes the bucket directly", () => {
    expect(Object.keys(subCommandsOf(app))).toContain("lease");
    expect(Object.keys(subCommandsOf(lease()))).toEqual(["show", "drop"]);

    for (const name of ["show", "drop"]) {
      const args = Object.keys(argsOf(lease(), name));
      for (const flag of ["name", "env", "node", "json"]) expect(args, flag).toContain(flag);
      for (const flag of ["endpoint", "region", "bucket", "prefix", "access-key", "secret-key"]) {
        expect(args, `${name} ${flag}`).toContain(flag);
      }
    }
  });

  it("asks before it deletes, and takes a dry run and a force", () => {
    const args = argsOf(lease(), "drop") as Record<
      string,
      { description?: string; required?: boolean }
    >;

    expect(Object.keys(args)).toEqual(expect.arrayContaining(["yes", "dry-run", "force"]));
    expect(args.node?.required, "a drop names the one node it deletes").toBe(true);
    expect(args.yes?.description ?? "").toContain("asking");
    expect(args.force?.description ?? "").toContain("still held");
  });

  it("says in its own help what the three reads are for", () => {
    const description = descriptionOf(lease(), "show");

    expect(description).toContain("LIST");
    expect(description).toContain("HEAD");
    expect(description).toContain("GET");
    expect(description).toContain("unreadable");
  });

  it("warns on every run that it touches Celld's records and will be removed", () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    warnUnstable("scafo app lease", LEASE_UNSTABLE_WHY);

    expect(lines).toEqual([
      `scafo: warning: "scafo app lease" is subject to change: ${LEASE_UNSTABLE_WHY}`,
    ]);
    expect(LEASE_UNSTABLE_WHY).toContain("Celld's own keyspace");
    expect(LEASE_UNSTABLE_WHY).toContain("removed once Celld recovers such a lease itself");
    for (const release of VERIFIED_CELLD_RELEASES) expect(LEASE_UNSTABLE_WHY).toContain(release);
  });

  it("is silenced by the one switch that silences every warning", () => {
    vi.stubEnv("SCAFO_SILENCE_WARNINGS", "1");
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    warnUnstable("scafo app lease", LEASE_UNSTABLE_WHY);

    expect(lines).toEqual([]);
  });
});

describe("the lines a reading prints", () => {
  it("lays the three reads side by side, then the verdict's own sentence", () => {
    const lines = describeLeases("shop-production", [unreadable()]);

    expect(lines[0]).toBe(`unreadable ${KEY}`);
    expect(lines[1]).toBe(`  LIST 412 bytes, etag "m3", modified 2026-09-19T10:00:00.000Z`);
    expect(lines[2]).toBe(`  HEAD 412 bytes, etag "m3", modified 2026-09-19T10:00:00.000Z`);
    expect(lines[3]).toBe("  GET  not there");
    expect(lines[4]).toContain("the listing names it");
  });

  it("names the drop that clears the first unreadable lease it found", () => {
    const lines = describeLeases("shop-production", [held("node-z"), unreadable()]);

    expect(lines.at(-1)).toContain("1 held, 1 unreadable of 2 node leases");
    expect(lines.at(-1)).toContain(`scafo app lease drop --name shop-production --node node-a`);
  });

  it("says nothing about a drop when every lease reads cleanly", () => {
    const summary =
      describeLeases("shop-production", [held("node-a"), held("node-b")]).at(-1) ?? "";

    expect(summary).toContain("2 held of 2 node leases");
    expect(summary).not.toContain("drop");
  });

  it("says plainly when a fleet holds no lease at all", () => {
    const lines = describeLeases("shop-production", []);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no Celld node lease at all");
  });

  it("reports a read that failed as what it raised, rather than as an absence", () => {
    const reading = { ...unreadable() };
    reading.get = { present: false, error: "Store did not answer: HTTP 503" };

    expect(describeLeases("shop-production", [reading])[3]).toBe(
      "  GET  failed: Store did not answer: HTTP 503",
    );
  });
});

describe("the question a drop asks", () => {
  it("prints the reading before it asks, because that is what is consented to", async () => {
    const run = session({ answer: "y" });

    await run.go();

    expect(run.asked).toHaveLength(1);
    expect(run.saidWhenAsked()).toBeGreaterThan(0);
    expect(run.said[0]).toBe(`unreadable ${KEY}`);
  });

  it("deletes on a yes and says what the key says afterwards", async () => {
    const run = session({ answer: "yes" });

    await run.go();

    expect(run.dropped()).toBe(1);
    expect(run.said.at(-1)).toContain(`deleted "${KEY}"`);
    expect(run.said.at(-1)).toContain("the key is gone");
  });

  it("deletes nothing on anything but a yes", async () => {
    const run = session({ answer: "" });

    await run.go();

    expect(run.dropped()).toBe(0);
    expect(run.said.at(-1)).toBe("scafo: nothing deleted");
  });

  it("answers the question ahead of time with --yes, and asks nobody", async () => {
    const run = session({ yes: true, isTTY: false });

    await run.go();

    expect(run.asked).toEqual([]);
    expect(run.dropped()).toBe(1);
  });

  it("refuses rather than take silence for consent when nothing can be asked", async () => {
    const run = session({ isTTY: false });

    const error = await rejectsWith(() => run.go(), "invalid-input");

    expect(error.detail).toContain("scafo app lease drop");
    expect(error.detail).toContain("--yes");
    expect(run.dropped()).toBe(0);
  });

  it("says what would go on a dry run, asks nothing and deletes nothing", async () => {
    const run = session({ dryRun: true, answer: "y" });

    await run.go();

    expect(run.asked).toEqual([]);
    expect(run.dropped()).toBe(0);
    expect(run.said.at(-1)).toContain(`would delete "${KEY}"`);
  });

  it("asks nothing about a key that is not there", async () => {
    const run = session({ before: absent(), answer: "y" });

    await run.go();

    expect(run.asked).toEqual([]);
    expect(run.dropped()).toBe(0);
    expect(run.said.at(-1)).toContain("nothing to drop");
  });

  it("says in the question itself what forcing a held lease costs", async () => {
    const run = session({ before: held("node-a"), force: true, answer: "y" });

    await run.go();

    expect(run.asked[0]).toContain("IT IS STILL HELD");
    expect(run.asked[0]).toContain("while the first still serves them");
    expect(run.dropped()).toBe(1);
  });

  it("carries the whole exchange as JSON when asked, and prints no report beside it", async () => {
    const run = session({ json: true, yes: true });

    await run.go();

    expect(run.said).toHaveLength(1);
    const answer = JSON.parse(run.said[0] ?? "{}") as Record<string, unknown>;
    expect(answer.application).toBe("shop-production");
    expect(answer.node).toBe("node-a");
    expect(answer.key).toBe(KEY);
    expect(answer.deleted).toBe(true);
    expect(answer.stillThere).toBe(false);
    expect((answer.before as CelldLeaseReading).verdict).toBe("unreadable");
    expect((answer.after as CelldLeaseReading).verdict).toBe("absent");
  });

  it("says in JSON that a declined run deleted nothing", async () => {
    const run = session({ json: true, answer: "n" });

    await run.go();

    const answer = JSON.parse(run.said[0] ?? "{}") as Record<string, unknown>;
    expect(answer.deleted).toBe(false);
    expect(answer.after).toBeUndefined();
  });
});

describe("what a finished drop says", () => {
  it("tells the operator the node may be restarted once the key is gone", () => {
    expect(describeLeaseDrop(drop({ stillThere: false }))).toContain("the key is gone");
  });

  it("does not claim a deletion the store still answers for", () => {
    const said = describeLeaseDrop(drop({ stillThere: true }));

    expect(said).toContain("still answers for it");
    expect(said).toContain("before restarting the node");
  });
});

/* ------------------------------------------------------------------ fixtures */

function subCommandsOf(command: CommandDef): Record<string, CommandDef> {
  return command.subCommands as Record<string, CommandDef>;
}

function lease(): CommandDef {
  const found = subCommandsOf(app).lease;
  if (found === undefined) throw new Error("no lease subcommand");
  return found;
}

function argsOf(command: CommandDef, name: string): ArgsDef {
  const sub = subCommandsOf(command)[name];
  if (sub === undefined) throw new Error(`no "${name}" subcommand`);
  return sub.args as ArgsDef;
}

function descriptionOf(command: CommandDef, name: string): string {
  const sub = subCommandsOf(command)[name];
  if (sub === undefined) throw new Error(`no "${name}" subcommand`);
  return (sub.meta as { description: string }).description;
}

/** The incident's own reading: listed, HEAD-able, and never answered. */
function unreadable(): CelldLeaseReading {
  return {
    application: "shop-production",
    node: "node-a",
    key: KEY,
    listed: { present: true, size: 412, etag: `"m3"`, lastModified: "2026-09-19T10:00:00.000Z" },
    head: { present: true, size: 412, etag: `"m3"`, lastModified: "2026-09-19T10:00:00.000Z" },
    get: { present: false },
    verdict: "unreadable",
    why: "the listing names it and a HEAD of it answers, and a GET of it says it is not there",
  };
}

function held(node: string): CelldLeaseReading {
  return {
    application: "shop-production",
    node,
    key: `fleets/shop-production/nodes/${node}.json`,
    listed: { present: true, size: 412, etag: `"m1"` },
    head: { present: true, size: 412, etag: `"m1"` },
    get: { present: true, size: 412, etag: `"m1"` },
    verdict: "held",
    why: "it is a node lease that runs until 2026-09-19T10:01:00.000Z",
    expiresAt: "2026-09-19T10:01:00.000Z",
  };
}

function absent(): CelldLeaseReading {
  return {
    application: "shop-production",
    node: "node-a",
    key: KEY,
    listed: { present: false },
    head: { present: false },
    get: { present: false },
    verdict: "absent",
    why: "nothing is there: the listing, a HEAD and a GET all say so",
  };
}

function drop(opts: { stillThere: boolean }): CelldLeaseDrop {
  const before = unreadable();
  return {
    before,
    deleted: true,
    after: opts.stillThere ? before : absent(),
    stillThere: opts.stillThere,
  };
}

/** One run of the dialog with everything that touches a terminal or a bucket recorded. */
function session(
  opts: {
    before?: CelldLeaseReading;
    answer?: string;
    yes?: boolean;
    force?: boolean;
    json?: boolean;
    isTTY?: boolean;
    dryRun?: boolean;
  } = {},
): {
  said: string[];
  asked: string[];
  dropped: () => number;
  saidWhenAsked: () => number;
  go: () => Promise<void>;
} {
  const said: string[] = [];
  const asked: string[] = [];
  let saidWhenAsked = -1;
  let dropped = 0;

  const before = opts.before ?? unreadable();
  const dialog: LeaseDropDialog = {
    before,
    ...(opts.dryRun === true ? { dryRun: true } : {}),
    force: opts.force === true,
    yes: opts.yes === true,
    ...(opts.json === true ? { json: true } : {}),
    isTTY: opts.isTTY ?? true,
    ask: (question: string): Promise<string> => {
      asked.push(question);
      saidWhenAsked = said.length;
      return Promise.resolve(opts.answer ?? "");
    },
    drop: (): Promise<CelldLeaseDrop> => {
      dropped += 1;
      return Promise.resolve({ before, deleted: true, after: absent(), stillThere: false });
    },
    say: (line: string): void => {
      said.push(line);
    },
  };

  return {
    said,
    asked,
    dropped: (): number => dropped,
    saidWhenAsked: (): number => saidWhenAsked,
    go: (): Promise<void> => runLeaseDropDialog(dialog),
  };
}
