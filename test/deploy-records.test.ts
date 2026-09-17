/*
 * Deploy records: the registry document a deploy's state lives in, so that any
 * node can answer a poll and a restart of the accepting node loses nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  createDeployRecord,
  getDeployRecord,
  listDeployRecords,
  updateDeployRecord,
} from "../src/core/registry/index.ts";
import { deployKey, deploysPrefix } from "../src/core/registry/paths.ts";
import type { DeploymentSource, CarriedVarset, OidcActor } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "shop";
const NODE = "node-a";
const ENVIRONMENT = "production";
const ID = `${PROJECT}.a1b2c3d4e5f60718`;
const OTHER = `${PROJECT}.00112233445566ff`;
const MINUTE_MS = 60_000;

const SOURCE: DeploymentSource = {
  provider: "github",
  repo: "acme/shop",
  ref: "refs/heads/main",
  commit: "c0ffee",
};
const OIDC: OidcActor = { issuer: "https://issuer.test", subject: "repo:acme/shop" };
const VARSET: CarriedVarset = { name: "prod", hash: "d1d1d1d1" };

let clock: ManualClock;

beforeEach(() => {
  clock = ctxWith(new MemoryCasStore());
});

describe("where a deploy record lives", () => {
  it("files it under the project its id names", () => {
    expect(deploysPrefix(PROJECT)).toBe(`_scafo/projects/${PROJECT}/deploys/`);
    expect(deployKey(PROJECT, ID)).toBe(`_scafo/projects/${PROJECT}/deploys/${ID}.json`);
  });

  it.each([
    ["a name that is no deploy id", "not-a-deploy"],
    ["a token with no project", "a1b2c3d4e5f60718"],
    ["a short token", `${PROJECT}.a1b2c3d4e5f607`],
    ["an uppercase token", `${PROJECT}.A1B2C3D4E5F60718`],
    ["a path in place of a project", `../trust.a1b2c3d4e5f60718`],
  ])("refuses %s as a key", (_what, id) => {
    expect(() => deployKey(PROJECT, id)).toThrowError(/Invalid deploy id/);
  });
});

describe("createDeployRecord", () => {
  it("records an accepted deploy with the audit trail its caller carried", async () => {
    const record = await createDeployRecord(clock.ctx, PROJECT, {
      id: ID,
      environment: ENVIRONMENT,
      node: NODE,
      source: SOURCE,
      oidc: OIDC,
    });

    expect(record).toEqual({
      v: 1,
      id: ID,
      project: PROJECT,
      environment: ENVIRONMENT,
      state: "accepted",
      node: NODE,
      acceptedAt: new Date(clock.nowMs()).toISOString(),
      updatedAt: new Date(clock.nowMs()).toISOString(),
      source: SOURCE,
      oidc: OIDC,
    });
    await expect(getDeployRecord(clock.ctx, PROJECT, ID)).resolves.toEqual(record);
  });

  it("leaves out an audit trail the caller did not carry", async () => {
    const record = await createDeployRecord(clock.ctx, PROJECT, {
      id: ID,
      environment: ENVIRONMENT,
      node: NODE,
    });

    expect(record.source).toBeUndefined();
    expect(record.oidc).toBeUndefined();
  });

  it("refuses an id something is already recorded under", async () => {
    await createDeployRecord(clock.ctx, PROJECT, { id: ID, environment: ENVIRONMENT, node: NODE });

    const error = await rejectsWith(
      () =>
        createDeployRecord(clock.ctx, PROJECT, {
          id: ID,
          environment: ENVIRONMENT,
          node: "node-b",
        }),
      "immutable",
    );

    expect(error.detail).toContain(ID);
    /* And the first node keeps the deploy: nothing was overwritten. */
    await expect(getDeployRecord(clock.ctx, PROJECT, ID)).resolves.toMatchObject({ node: NODE });
  });
});

describe("updateDeployRecord", () => {
  beforeEach(async () => {
    await createDeployRecord(clock.ctx, PROJECT, { id: ID, environment: ENVIRONMENT, node: NODE });
  });

  it("moves a deploy through its states, stamping only the moment of the last one", async () => {
    const accepted = await getDeployRecord(clock.ctx, PROJECT, ID);
    clock.tick(MINUTE_MS);

    const uploading = await updateDeployRecord(clock.ctx, PROJECT, ID, { state: "uploading" });
    clock.tick(MINUTE_MS);
    const deployed = await updateDeployRecord(clock.ctx, PROJECT, ID, {
      state: "deployed",
      deployment: "b1b1b1b1",
      varset: VARSET,
    });

    expect(uploading.updatedAt).not.toBe(accepted.updatedAt);
    expect(deployed).toMatchObject({
      state: "deployed",
      deployment: "b1b1b1b1",
      varset: VARSET,
      acceptedAt: accepted.acceptedAt,
      updatedAt: new Date(clock.nowMs()).toISOString(),
    });
    await expect(getDeployRecord(clock.ctx, PROJECT, ID)).resolves.toEqual(deployed);
  });

  it("records why a deploy failed", async () => {
    const failed = await updateDeployRecord(clock.ctx, PROJECT, ID, {
      state: "failed",
      detail: "celld exited with code 1",
    });

    expect(failed).toMatchObject({ state: "failed", detail: "celld exited with code 1" });
  });

  it("never reopens a deploy that has already finished", async () => {
    await updateDeployRecord(clock.ctx, PROJECT, ID, { state: "deployed", deployment: "b1b1b1b1" });

    const error = await rejectsWith(
      () => updateDeployRecord(clock.ctx, PROJECT, ID, { state: "uploading" }),
      "cas-conflict",
    );

    expect(error.detail).toContain("deployed");
    await expect(getDeployRecord(clock.ctx, PROJECT, ID)).resolves.toMatchObject({
      state: "deployed",
      deployment: "b1b1b1b1",
    });
  });

  it("refuses a finished deploy after one read, without retrying the write", async () => {
    /* The refusal shares its error code with a lost conditional write, which
       the update loop retries from a fresh read; a deploy that has finished is
       final, so asking again would only repeat the answer. */
    const store = new FaultStore(new MemoryCasStore());
    const faulty = ctxWith(store);
    await createDeployRecord(faulty.ctx, PROJECT, { id: ID, environment: ENVIRONMENT, node: NODE });
    await updateDeployRecord(faulty.ctx, PROJECT, ID, {
      state: "deployed",
      deployment: "b1b1b1b1",
    });
    const reads = store.gets;
    const writes = store.puts;

    await rejectsWith(
      () => updateDeployRecord(faulty.ctx, PROJECT, ID, { state: "uploading" }),
      "cas-conflict",
    );

    expect(store.gets - reads).toBe(1);
    expect(store.puts - writes).toBe(0);
  });

  it("does not rewrite a deploy that succeeded as one that failed", async () => {
    /* The accepting node's own failure handler runs after the commit point too:
       the deploy HAPPENED, and a late refusal must not say otherwise. */
    await updateDeployRecord(clock.ctx, PROJECT, ID, { state: "deployed", deployment: "b1b1b1b1" });

    await rejectsWith(
      () => updateDeployRecord(clock.ctx, PROJECT, ID, { state: "failed", detail: "too late" }),
      "cas-conflict",
    );

    await expect(getDeployRecord(clock.ctx, PROJECT, ID)).resolves.toMatchObject({
      state: "deployed",
    });
  });

  it("refuses an id nothing is recorded under", async () => {
    const error = await rejectsWith(
      () => updateDeployRecord(clock.ctx, PROJECT, OTHER, { state: "uploading" }),
      "not-found",
    );

    expect(error.detail).toContain(OTHER);
  });
});

describe("reading deploy records back", () => {
  it("says an id it has never recorded is not there, and names it", async () => {
    const error = await rejectsWith(() => getDeployRecord(clock.ctx, PROJECT, ID), "not-found");

    expect(error.detail).toContain(ID);
  });

  it("lists every deploy of one project, and no other project's", async () => {
    await createDeployRecord(clock.ctx, PROJECT, { id: OTHER, environment: "preview", node: NODE });
    await createDeployRecord(clock.ctx, PROJECT, { id: ID, environment: ENVIRONMENT, node: NODE });
    await createDeployRecord(clock.ctx, "rival", {
      id: "rival.ffffffffffffffff",
      environment: ENVIRONMENT,
      node: NODE,
    });

    const records = await listDeployRecords(clock.ctx, PROJECT);

    expect(records.map((record) => record.id)).toEqual([OTHER, ID].sort());
    expect(records.every((record) => record.project === PROJECT)).toBe(true);
  });

  it("lists nothing for a project that has never been deployed", async () => {
    await expect(listDeployRecords(clock.ctx, "rival")).resolves.toEqual([]);
  });
});
