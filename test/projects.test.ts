/* The project record: what a project IS in the registry, beyond a slug that happens to have builds under it. */

import { beforeEach, describe, expect, it } from "vitest";
import { putJson, readJson } from "../src/core/registry/cas.ts";
import { CLOCK_START_MS, ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";
import { projectKey } from "../src/core/registry/paths.ts";
import {
  blockProject,
  createProject,
  getProject,
  setProjectLabels,
  unblockProject,
  updateProject,
} from "../src/core/registry/projects.ts";
import type { ProjectRecord } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";

const PROJECT = "shop";

let clock: ManualClock;

beforeEach(() => {
  clock = ctxWith(new MemoryCasStore());
});

describe("when a project came into being", () => {
  it("stamps createdAt on the first creation", async () => {
    const created = await createProject(clock.ctx, { slug: PROJECT });

    expect(created.createdAt).toBe(new Date(CLOCK_START_MS).toISOString());
    await expect(getProject(clock.ctx, PROJECT)).resolves.toMatchObject({
      createdAt: created.createdAt,
    });
  });

  it("leaves the first stamp alone when a retried create finds the project there", async () => {
    const first = await createProject(clock.ctx, { slug: PROJECT });
    clock.tick(60_000);

    const again = await createProject(clock.ctx, { slug: PROJECT });

    /* The slug is the whole identity and creation is idempotent, so a second
       deploy into the same project must not restate when it began. */
    expect(again.createdAt).toBe(first.createdAt);
  });

  it("NEVER backfills one onto a record written before there were stamps", async () => {
    await putJson<ProjectRecord>(clock.ctx, projectKey(PROJECT), {
      v: 1,
      slug: PROJECT,
    });

    /* Absent stays absent. A stamp invented now would say the project was
       created at the moment somebody happened to read it, which is worse than
       admitting that this installation predates the field. */
    await expect(createProject(clock.ctx, { slug: PROJECT })).resolves.not.toHaveProperty(
      "createdAt",
    );
    await expect(getProject(clock.ctx, PROJECT)).resolves.not.toHaveProperty("createdAt");
  });
});

describe("labels", () => {
  it("round-trips a map, and replaces it wholesale", async () => {
    await createProject(clock.ctx, { slug: PROJECT });

    await setProjectLabels(clock.ctx, PROJECT, { tenant: "acme", plan: "pro" });
    await expect(getProject(clock.ctx, PROJECT)).resolves.toMatchObject({
      labels: { tenant: "acme", plan: "pro" },
    });

    /* REPLACES rather than merges: the caller states the whole map, so a label
       dropped downstream is gone here rather than surviving forever. */
    await setProjectLabels(clock.ctx, PROJECT, { tenant: "acme" });
    await expect(getProject(clock.ctx, PROJECT)).resolves.toMatchObject({
      labels: { tenant: "acme" },
    });
  });

  it("drops the field entirely when the map is emptied", async () => {
    await createProject(clock.ctx, { slug: PROJECT });
    await setProjectLabels(clock.ctx, PROJECT, { tenant: "acme" });

    await setProjectLabels(clock.ctx, PROJECT, {});

    await expect(getProject(clock.ctx, PROJECT)).resolves.not.toHaveProperty("labels");
  });
});

describe("blocking a project", () => {
  it("sets the flag, and clears it on the way back", async () => {
    await createProject(clock.ctx, { slug: PROJECT });

    await expect(blockProject(clock.ctx, PROJECT)).resolves.toMatchObject({ blocked: true });
    await expect(unblockProject(clock.ctx, PROJECT)).resolves.not.toHaveProperty("blocked");
  });

  it("is idempotent in both directions", async () => {
    await createProject(clock.ctx, { slug: PROJECT });

    await blockProject(clock.ctx, PROJECT);
    await expect(blockProject(clock.ctx, PROJECT)).resolves.toMatchObject({ blocked: true });

    await unblockProject(clock.ctx, PROJECT);
    /* Unblocking one that was never blocked is not an error: a downstream
       platform retrying its own dunning pass must cost nothing. */
    await expect(unblockProject(clock.ctx, PROJECT)).resolves.not.toHaveProperty("blocked");
  });

  it("absent means not blocked, so nothing has to be written to start serving", async () => {
    const created = await createProject(clock.ctx, { slug: PROJECT });

    expect(created).not.toHaveProperty("blocked");
  });

  it("touches nothing else about the project", async () => {
    await createProject(clock.ctx, { slug: PROJECT });
    await setProjectLabels(clock.ctx, PROJECT, { tenant: "acme" });
    const before = await getProject(clock.ctx, PROJECT);

    await blockProject(clock.ctx, PROJECT);
    await unblockProject(clock.ctx, PROJECT);

    /* The whole promise of the verb: env and build records are untouched and so
       is the project's own configuration, so unblocking restores what was there
       rather than something reconstructed. */
    await expect(getProject(clock.ctx, PROJECT)).resolves.toEqual(before);
  });

  it("refuses a project that is not there", async () => {
    await rejectsWith(() => blockProject(clock.ctx, PROJECT), "not-found");
  });
});

describe("what may never change", () => {
  it("keeps v and slug immutable through an update", async () => {
    await createProject(clock.ctx, { slug: PROJECT });

    await rejectsWith(
      () => updateProject(clock.ctx, PROJECT, (current) => ({ ...current, slug: "other" })),
      "immutable",
    );
    await rejectsWith(
      () =>
        updateProject(clock.ctx, PROJECT, (current) => ({
          ...current,
          v: 2 as unknown as 1,
        })),
      "immutable",
    );
  });

  it("keeps them immutable through the block verbs too", async () => {
    await createProject(clock.ctx, { slug: PROJECT });
    await blockProject(clock.ctx, PROJECT);

    const stored = await readJson<ProjectRecord>(clock.ctx, projectKey(PROJECT));
    expect(stored?.value).toMatchObject({ v: 1, slug: PROJECT });
  });
});
