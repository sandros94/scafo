/*
 * Pruning an environment's Celld publications: what the fleet's own selector
 * protects, what age and count select, and what is never touched.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createDeployment, createEnvironment, createProject } from "../src/core/registry/index.ts";
import {
  deploymentKey,
  deployBlobsPrefix,
  deployPointerKey,
  fleetPrefix,
} from "../src/core/registry/paths.ts";
import { executePrune, planPrune, type PrunePlan } from "../src/core/registry/prune.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "shop";
const ENV = "production";
const SCRIPT = "app";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const FLEET = `${fleetPrefix(PROJECT, ENV)}/`;
const DEPLOY = `${FLEET}deploy/`;

/** Asset digests, 64 lowercase hex as Celld writes them; each is one blob. */
const SHARED = digestOf("a");
const ORPHAN = digestOf("b");
const PINNED = digestOf("c");

/** The one blob every publication of the fixture references. */
const SHARED_BLOB = blobKey(SHARED);

/** Four versions, published an hour apart in this order. */
const V1 = "aaaa1111";
const V2 = "bbbb2222";
const V3 = "cccc3333";
const V4 = "dddd4444";

let inner: MemoryCasStore;
let store: FaultStore;
let clock: ManualClock;

beforeEach(async () => {
  /* The store stamps every write with the test's own clock, so a blob has the
     age the test gave it rather than the age the suite took to run. */
  inner = new MemoryCasStore({ now: (): Date => new Date(clock.nowMs()) });
  store = new FaultStore(inner);
  clock = ctxWith(store);

  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, { name: ENV });
  await putBlob(SHARED);
});

describe("reading the fleet's own selector", () => {
  beforeEach(async () => {
    await publishAll();
    await pointAt(V4);
  });

  it("refuses a fleet whose selector is not there at all", async () => {
    await store.del(deployPointerKey(PROJECT, ENV));

    const error = await rejectsWith(() => plan(), "store-nonconforming");

    expect(error.detail).toContain("deploy/current.json");
    expect(error.detail).toContain(`${PROJECT}/${ENV}`);
  });

  it.each([
    ["an array", "[]"],
    ["a bare string", `"dddd4444"`],
    ["a pointer with no version", JSON.stringify({ prefix: "deploy/app/x", script_name: "app" })],
    ["a pointer with no prefix", JSON.stringify({ version: "x", script_name: "app" })],
    ["a pointer with no script", JSON.stringify({ version: "x", prefix: "deploy/app/x" })],
  ])("refuses %s in place of the fleet-wide pointer", async (_case, body) => {
    await store.put(deployPointerKey(PROJECT, ENV), body);

    const error = await rejectsWith(() => plan(), "store-nonconforming");

    expect(error.detail).toContain("deploy/current.json");
  });

  it("refuses a selector that is not JSON at all", async () => {
    await store.put(deployPointerKey(PROJECT, ENV), "not json");

    const error = await rejectsWith(() => plan(), "store-nonconforming");

    expect(error.detail).toContain("deploy/current.json");
  });

  it("refuses a per-script pointer it cannot read either", async () => {
    await store.put(`${DEPLOY}${SCRIPT}/current.json`, "{}");

    const error = await rejectsWith(() => plan(), "store-nonconforming");

    expect(error.detail).toContain(`${SCRIPT}/current.json`);
  });
});

describe("what a plan protects", () => {
  it("never proposes the version a pointer names, however old it is", async () => {
    await publishAll();
    await pointAt(V1);

    const made = await plan({ keep: 0 });

    expect(made.current).toEqual([V1]);
    expect(names(made.delete)).toEqual([`${SCRIPT}/${V4}`, `${SCRIPT}/${V3}`, `${SCRIPT}/${V2}`]);
    expect(reasons(made)).toEqual({ [`${SCRIPT}/${V1}`]: "current" });
  });

  it("protects what another script's pointer names, not only the fleet-wide one", async () => {
    await publishAll();
    await pointAt(V4);
    await publish("eeee5555", { script: "worker" });
    await store.put(
      `${DEPLOY}worker/current.json`,
      JSON.stringify({
        version: "eeee5555",
        prefix: "deploy/worker/eeee5555",
        script_name: "worker",
      }),
    );

    const made = await plan({ keep: 0 });

    expect(made.current).toEqual([V4, "eeee5555"]);
    expect(names(made.delete)).not.toContain("worker/eeee5555");
  });
});

describe("what a plan selects", () => {
  it("keeps the newest deployments, ordered by when scafo recorded each version", async () => {
    await publishAll();
    await pointAt(V4);

    const made = await plan({ keep: 2 });

    expect(names(made.keep)).toEqual([`${SCRIPT}/${V4}`, `${SCRIPT}/${V3}`]);
    expect(names(made.delete)).toEqual([`${SCRIPT}/${V2}`, `${SCRIPT}/${V1}`]);
    expect(reasons(made)).toEqual({
      [`${SCRIPT}/${V4}`]: "current",
      [`${SCRIPT}/${V3}`]: "within-keep",
    });
  });

  it("counts a deployment it has no record for as the oldest thing there is", async () => {
    await publishAll();
    await pointAt(V4);
    /* Written last, so only the missing record can put it at the back. */
    await publish("ffff6666", { record: false });

    const made = await plan({ keep: 3 });

    /* Newest first throughout, so the one nothing recorded is at the very back. */
    expect(names(made.delete)).toEqual([`${SCRIPT}/${V1}`, `${SCRIPT}/ffff6666`]);
  });

  it("deletes only what is older than the window it was given", async () => {
    await publishAll();
    await pointAt(V4);

    /* V1 is three hours old, V2 two, V3 one, V4 the moment of the plan. */
    const made = await plan({ keep: 0, olderThanMs: 2.5 * HOUR_MS });

    expect(names(made.delete)).toEqual([`${SCRIPT}/${V1}`]);
    expect(reasons(made)).toEqual({
      [`${SCRIPT}/${V4}`]: "current",
      [`${SCRIPT}/${V3}`]: "within-age",
      [`${SCRIPT}/${V2}`]: "within-age",
    });
  });

  it("reads a publication with no record as older than any window", async () => {
    await publishAll();
    await pointAt(V4);
    await publish("ffff6666", { record: false });

    const made = await plan({ keep: 0, olderThanMs: 365 * 24 * HOUR_MS });

    expect(names(made.delete)).toEqual([`${SCRIPT}/ffff6666`]);
  });

  it("carries every object of a doomed publication and the record filed under its version", async () => {
    await publishAll();
    await pointAt(V4);
    await publish("ffff6666", { record: false });

    const made = await plan({ keep: 1 });
    const oldest = made.delete.find((one) => one.version === V1);

    expect(oldest?.prefix).toBe(`${DEPLOY}${SCRIPT}/${V1}/`);
    expect(oldest?.keys).toEqual([
      `${DEPLOY}${SCRIPT}/${V1}/assets.json`,
      `${DEPLOY}${SCRIPT}/${V1}/manifest.json`,
      `${DEPLOY}${SCRIPT}/${V1}/modules/index.js`,
    ]);
    expect(oldest?.recordKey).toBe(deploymentKey(PROJECT, V1));
    /* Nothing to delete beside the objects when scafo never recorded the deployment. */
    expect(made.delete.find((one) => one.version === "ffff6666")?.recordKey).toBeUndefined();
  });

  it("never names a pointer or a shared asset blob in anything it plans", async () => {
    await publishAll();
    await pointAt(V4);

    const made = await plan({ keep: 0 });
    const planned = [...made.keep, ...made.delete].flatMap((one) => one.keys);

    expect(planned.filter((key) => key.startsWith(deployBlobsPrefix(PROJECT, ENV)))).toEqual([]);
    expect(planned.filter((key) => key.endsWith("/current.json"))).toEqual([]);
  });
});

describe("the age gate, which is always on", () => {
  beforeEach(async () => {
    await publishAll();
    await pointAt(V4);
  });

  it("keeps a deployment younger than the window however far past the keep count it is", async () => {
    const made = await plan({ keep: 1, olderThanMs: DAY_MS });

    expect(names(made.delete)).toEqual([]);
    expect(reasons(made)).toEqual({
      [`${SCRIPT}/${V4}`]: "current",
      [`${SCRIPT}/${V3}`]: "within-age",
      [`${SCRIPT}/${V2}`]: "within-age",
      [`${SCRIPT}/${V1}`]: "within-age",
    });
  });

  it("deletes whatever the keep count did not spare when the window is zero", async () => {
    const made = await plan({ keep: 1, olderThanMs: 0 });

    expect(names(made.delete)).toEqual([`${SCRIPT}/${V3}`, `${SCRIPT}/${V2}`, `${SCRIPT}/${V1}`]);
  });

  it.each([
    ["with both gates lifted", 0, 0],
    ["with the age gate lifted", 0, DAY_MS],
    ["with the keep count lifted", 10, 0],
    ["with neither lifted", 10, DAY_MS],
  ])("never deletes what a pointer names, %s", async (_case, keep, olderThanMs) => {
    await pointAt(V1);

    const made = await plan({ keep, olderThanMs });

    expect(names(made.delete)).not.toContain(`${SCRIPT}/${V1}`);
    expect(made.keep.find((one) => one.version === V1)?.reason).toBe("current");
  });
});

/*
 * The four fleets the defaults were weighed against. `keep` and `olderThanMs`
 * are what the CLI hands over: ten deployments and a day, unless an operator
 * lifts one of the two gates with a zero.
 */
describe("what the two gates select over a fleet's history", () => {
  const KEEP = 10;
  const WINDOW = DAY_MS;

  const SCENARIOS = [
    {
      fleet: "20 deployments, none of them a day old",
      published: [{ count: 20, apart: HOUR_MS }],
      gates: [
        { keep: KEEP, olderThanMs: WINDOW, deleted: 0 },
        { keep: KEEP, olderThanMs: 0, deleted: 10 },
        { keep: 0, olderThanMs: 0, deleted: 19 },
      ],
    },
    {
      fleet: "20 deployments, 12 of them older than a day",
      published: [
        { count: 12, apart: HOUR_MS },
        { count: 1, apart: 30 * HOUR_MS },
        { count: 7, apart: HOUR_MS },
      ],
      gates: [{ keep: KEEP, olderThanMs: WINDOW, deleted: 10 }],
    },
    {
      fleet: "5 deployments, 4 of them a week old",
      published: [
        { count: 4, apart: HOUR_MS },
        { count: 1, apart: 7 * DAY_MS },
      ],
      gates: [
        { keep: KEEP, olderThanMs: WINDOW, deleted: 0 },
        { keep: 1, olderThanMs: WINDOW, deleted: 4 },
      ],
    },
    {
      fleet: "30 deployments published within two hours",
      published: [{ count: 30, apart: 4 * 60_000 }],
      gates: [
        { keep: KEEP, olderThanMs: WINDOW, deleted: 0 },
        { keep: KEEP, olderThanMs: 0, deleted: 20 },
        { keep: 0, olderThanMs: 0, deleted: 29 },
      ],
    },
  ];

  it.each(SCENARIOS)("$fleet", async ({ published, gates }) => {
    const versions: string[] = [];
    for (const group of published) {
      for (let index = 0; index < group.count; index += 1) {
        const version = versionOf(versions.length);
        await publish(version, { after: group.apart });
        versions.push(version);
      }
    }
    const newest = versions.at(-1) as string;
    await pointAt(newest);

    for (const gate of gates) {
      const made = await plan({ keep: gate.keep, olderThanMs: gate.olderThanMs });
      const where = `keep ${String(gate.keep)}, window ${String(gate.olderThanMs)}`;

      expect(made.delete.length, where).toBe(gate.deleted);
      /* Whatever the gates said, the deployment the fleet serves is not among them. */
      expect(names(made.delete), where).not.toContain(`${SCRIPT}/${newest}`);
    }
  });
});

/*
 * The content-addressed blobs every deployment of an environment shares. They
 * are reference counted against what STAYS, and the age window is what keeps a
 * deploy in flight — blobs first, manifest and pointer after — from being
 * collected while it is happening.
 */
describe("the shared asset blobs", () => {
  it("deletes a blob only a deleted deployment named, once it is older than the window", async () => {
    await putBlob(ORPHAN);
    await publish(V1, { assets: [SHARED, ORPHAN] });
    await publish(V2);
    await publish(V3);
    await publish(V4);
    await pointAt(V4);

    const made = await plan({ keep: 1, olderThanMs: 2 * HOUR_MS });

    expect(names(made.delete)).toEqual([`${SCRIPT}/${V1}`]);
    expect(made.blobs.delete).toEqual([blobKey(ORPHAN)]);
    /* The one every kept deployment still names. */
    expect(made.blobs.keep).toBe(1);
  });

  it("keeps a blob a kept deployment names, however old the blob is", async () => {
    await publishAll();
    await pointAt(V4);
    clock.tick(365 * DAY_MS);

    const made = await plan({ keep: 0, olderThanMs: HOUR_MS });

    expect(names(made.delete)).toEqual([`${SCRIPT}/${V3}`, `${SCRIPT}/${V2}`, `${SCRIPT}/${V1}`]);
    expect(made.blobs).toEqual({ keep: 1, delete: [] });
  });

  it("keeps a blob nobody names while it is younger than the window", async () => {
    await publishAll();
    await pointAt(V4);
    /* Uploaded a moment ago: this is what a deploy in flight looks like from
       here, and what the window exists to protect. */
    await putBlob(ORPHAN);

    const made = await plan({ keep: 0, olderThanMs: HOUR_MS });

    expect(made.blobs).toEqual({ keep: 2, delete: [] });
  });

  it("deletes that same young blob once the age gate is lifted", async () => {
    await publishAll();
    await pointAt(V4);
    await putBlob(ORPHAN);

    const made = await plan({ keep: 0, olderThanMs: 0 });

    expect(made.blobs).toEqual({ keep: 1, delete: [blobKey(ORPHAN)] });
  });

  it("keeps the blobs of the deployment a pointer names, and nothing else keeps", async () => {
    await putBlob(PINNED);
    await publish(V1, { assets: [SHARED, PINNED] });
    await publish(V2);
    await publish(V3);
    await publish(V4);
    await pointAt(V1);

    const made = await plan({ keep: 0, olderThanMs: 0 });

    expect(reasons(made)).toEqual({ [`${SCRIPT}/${V1}`]: "current" });
    expect(made.blobs).toEqual({ keep: 2, delete: [] });
  });

  it("names no blob of a deployment that ships no asset index at all", async () => {
    await publish(V1, { assets: [] });
    await publish(V2, { assets: [] });
    await pointAt(V2);

    const made = await plan({ keep: 0, olderThanMs: 0 });

    /* Nothing references the fixture's blob any more, and nothing refuses either. */
    expect(made.blobs).toEqual({ keep: 0, delete: [SHARED_BLOB] });
  });

  it("leaves an object under deploy-blobs/ it cannot read as a digest where it is", async () => {
    await publishAll();
    await pointAt(V4);
    const stray = `${deployBlobsPrefix(PROJECT, ENV)}assets/sha256/ab/abcdef0123456789`;
    await store.put(stray, "not a blob this can reference-count");

    const made = await plan({ keep: 0, olderThanMs: 0 });

    expect(made.blobs).toEqual({ keep: 2, delete: [] });
  });

  it.each([
    ["is not JSON at all", "not json"],
    ["is not an object", "[]"],
    ["names no entries", JSON.stringify({ schema_version: 1, config: {} })],
    [
      "names a digest that is not one",
      JSON.stringify({ entries: { "/a.js": { sha256: "abcd" } } }),
    ],
  ])("refuses the whole plan when a kept deployment's asset index %s", async (_case, body) => {
    await publishAll();
    await pointAt(V4);
    await store.put(`${DEPLOY}${SCRIPT}/${V4}/assets.json`, body);

    const error = await rejectsWith(() => plan({ keep: 0, olderThanMs: 0 }), "store-nonconforming");

    expect(error.detail).toContain(`${V4}/assets.json`);
  });

  it("never reads the asset index of a deployment it is deleting anyway", async () => {
    await publishAll();
    await pointAt(V4);
    await store.put(`${DEPLOY}${SCRIPT}/${V1}/assets.json`, "not json");

    const made = await plan({ keep: 1, olderThanMs: 0 });

    expect(names(made.delete)).toContain(`${SCRIPT}/${V1}`);
    expect(made.blobs.delete).toEqual([]);
  });
});

describe("executePrune", () => {
  it("deletes exactly what the plan named, and leaves a referenced blob alone", async () => {
    await publishAll();
    await pointAt(V4);
    const made = await plan({ keep: 1 });

    const result = await executePrune(clock.ctx, made);

    expect(result.deleted.sort()).toEqual(
      [
        ...made.delete.flatMap((one) => one.keys),
        deploymentKey(PROJECT, V1),
        deploymentKey(PROJECT, V2),
        deploymentKey(PROJECT, V3),
      ].sort(),
    );
    const left = await store.list("");
    expect(left).toContain(SHARED_BLOB);
    expect(left).toContain(deployPointerKey(PROJECT, ENV));
    expect(left).toContain(`${DEPLOY}${SCRIPT}/${V4}/manifest.json`);
    expect(left.filter((key) => key.startsWith(`${DEPLOY}${SCRIPT}/${V1}/`))).toEqual([]);
  });

  it("deletes a deployment record before the objects it names, so a crash leaves them findable", async () => {
    await publishAll();
    await pointAt(V4);
    const made = await plan({ keep: 3 });
    store.failAfter(1, new Error("bucket went away"));

    await expect(executePrune(clock.ctx, made)).rejects.toThrow("bucket went away");

    const left = await store.list("");
    expect(left).not.toContain(deploymentKey(PROJECT, V1));
    /* Still there, and a later run counts a publication with no record as the
         oldest one, so nothing is stranded. */
    expect(left).toContain(`${DEPLOY}${SCRIPT}/${V1}/manifest.json`);
  });

  it("refuses a plan the pointers have moved under, deleting nothing of what they now name", async () => {
    await publishAll();
    await pointAt(V4);
    const made = await plan({ keep: 0 });
    /* A rollback landed after the plan was made: V2 is what the fleet serves now. */
    await pointAt(V2);

    const error = await rejectsWith(() => executePrune(clock.ctx, made), "cas-conflict");
    expect(error.detail).toContain(V2);

    const left = await store.list("");
    expect(left).toContain(`${DEPLOY}${SCRIPT}/${V2}/manifest.json`);
    expect(left).toContain(deploymentKey(PROJECT, V2));
  });

  it("deletes the blobs after the deployments that were still referencing them", async () => {
    await putBlob(ORPHAN);
    await publish(V1, { assets: [SHARED, ORPHAN] });
    await publish(V2);
    await publish(V3);
    await publish(V4);
    await pointAt(V4);
    const made = await plan({ keep: 1, olderThanMs: 0 });

    const result = await executePrune(clock.ctx, made);

    /* Last of everything: the deployments that referenced it are gone by then,
       so a run that dies halfway never strands a blob a live deployment needs. */
    expect(result.deleted.at(-1)).toBe(blobKey(ORPHAN));
    expect(result.deleted.filter((key) => key.startsWith(deployBlobsPrefix(PROJECT, ENV)))).toEqual(
      [blobKey(ORPHAN)],
    );

    const left = await store.list("");
    expect(left).not.toContain(blobKey(ORPHAN));
    expect(left).toContain(SHARED_BLOB);
  });

  it("does nothing at all for a plan that names nothing", async () => {
    await publishAll();
    await pointAt(V4);
    const made = await plan({ keep: 10 });
    const before = store.dels;

    const result = await executePrune(clock.ctx, made);

    expect(result.deleted).toEqual([]);
    expect(store.dels).toBe(before);
  });
});

/** A plan over the fixture, as of the clock's current moment. */
function plan(opts: { keep?: number; olderThanMs?: number } = {}): Promise<PrunePlan> {
  return planPrune(clock.ctx, {
    project: PROJECT,
    env: ENV,
    keep: opts.keep ?? 3,
    /* A zero window is the age gate lifted, which is how a test about the count
       alone says so; the gate itself is the subject further down. */
    olderThanMs: opts.olderThanMs ?? 0,
    now: new Date(clock.nowMs()),
  });
}

/** The four versions of {@link SCRIPT}, one hour apart, each with its deployment record. */
async function publishAll(): Promise<void> {
  for (const version of [V1, V2, V3, V4]) await publish(version);
}

/** One Celld deployment, `after` past the last (an hour by default), with the record scafo files for it. */
async function publish(
  version: string,
  opts: {
    script?: string;
    record?: boolean;
    after?: number;
    /** Digests its asset index names; none at all ships no index, as a bundle with no assets does. */
    assets?: string[];
  } = {},
): Promise<void> {
  const script = opts.script ?? SCRIPT;
  clock.tick(opts.after ?? HOUR_MS);

  const prefix = `${DEPLOY}${script}/${version}/`;
  await store.put(`${prefix}manifest.json`, JSON.stringify({ version }));
  await store.put(`${prefix}modules/index.js`, "export default {};");

  const assets = opts.assets ?? [SHARED];
  if (assets.length > 0) await store.put(`${prefix}assets.json`, assetIndex(assets));
  if (opts.record !== false) {
    await createDeployment(clock.ctx, PROJECT, { version });
  }
}

/** Celld's `assets.json`: a schema version and one entry per path, each naming its digest. */
function assetIndex(digests: string[]): string {
  return JSON.stringify({
    schema_version: 1,
    entries: Object.fromEntries(
      digests.map((digest, index) => [
        `/asset-${String(index)}.js`,
        { sha256: digest, bytes: 11, content_type: "text/javascript" },
      ]),
    ),
    config: {},
  });
}

/** One content-addressed blob, written at the clock's current moment. */
async function putBlob(digest: string): Promise<void> {
  await store.put(blobKey(digest), "asset-bytes");
}

/** Where Celld keeps the blob of `digest`: `assets/sha256/<first two hex>/<digest>`. */
function blobKey(digest: string): string {
  return `${deployBlobsPrefix(PROJECT, ENV)}assets/sha256/${digest.slice(0, 2)}/${digest}`;
}

/** A full digest made of one repeated hex character, readable in a failure message. */
function digestOf(character: string): string {
  return character.repeat(64);
}

/** Both pointers Celld keeps for `script`, aimed at `version`. */
async function pointAt(version: string, script: string = SCRIPT): Promise<void> {
  const body = JSON.stringify({
    version,
    prefix: `deploy/${script}/${version}`,
    script_name: script,
  });
  await store.put(deployPointerKey(PROJECT, ENV), body);
  await store.put(`${DEPLOY}${script}/current.json`, body);
}

/** A Celld-shaped version id for the nth publication of a series. */
function versionOf(index: number): string {
  return index.toString(16).padStart(8, "0");
}

function names(publications: Array<{ script: string; version: string }>): string[] {
  return publications.map((one) => `${one.script}/${one.version}`);
}

/** Why each kept publication was kept, by the name an operator reads. */
function reasons(made: PrunePlan): Record<string, string> {
  return Object.fromEntries(made.keep.map((one) => [`${one.script}/${one.version}`, one.reason]));
}
