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

const FLEET = `${fleetPrefix(PROJECT, ENV)}/`;
const DEPLOY = `${FLEET}deploy/`;
/** One content-addressed asset blob, shared by every publication that uses it. */
const BLOB = `${deployBlobsPrefix(PROJECT, ENV)}assets/sha256/ab/abcdef0123456789`;

/** Four versions, published an hour apart in this order. */
const V1 = "aaaa1111";
const V2 = "bbbb2222";
const V3 = "cccc3333";
const V4 = "dddd4444";

let inner: MemoryCasStore;
let store: FaultStore;
let clock: ManualClock;

beforeEach(async () => {
  inner = new MemoryCasStore();
  store = new FaultStore(inner);
  clock = ctxWith(store);

  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, { name: ENV });
  await store.put(BLOB, "asset-bytes");
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

describe("executePrune", () => {
  it("deletes exactly what the plan named, and leaves the shared blobs alone", async () => {
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
    expect(left).toContain(BLOB);
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
    ...(opts.olderThanMs === undefined ? {} : { olderThanMs: opts.olderThanMs }),
    now: new Date(clock.nowMs()),
  });
}

/** The four versions of {@link SCRIPT}, one hour apart, each with its deployment record. */
async function publishAll(): Promise<void> {
  for (const version of [V1, V2, V3, V4]) await publish(version);
}

/** One Celld deployment, an hour after the last, with the record scafo files for it. */
async function publish(
  version: string,
  opts: { script?: string; record?: boolean } = {},
): Promise<void> {
  const script = opts.script ?? SCRIPT;
  clock.tick(HOUR_MS);

  const prefix = `${DEPLOY}${script}/${version}/`;
  await store.put(`${prefix}manifest.json`, JSON.stringify({ version }));
  await store.put(`${prefix}modules/index.js`, "export default {};");
  if (opts.record !== false) {
    await createDeployment(clock.ctx, PROJECT, { version });
  }
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

function names(publications: Array<{ script: string; version: string }>): string[] {
  return publications.map((one) => `${one.script}/${one.version}`);
}

/** Why each kept publication was kept, by the name an operator reads. */
function reasons(made: PrunePlan): Record<string, string> {
  return Object.fromEntries(made.keep.map((one) => [`${one.script}/${one.version}`, one.reason]));
}
