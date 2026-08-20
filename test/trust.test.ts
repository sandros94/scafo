/* Which CI issuers may deploy a project, and how loosely their subjects match. */

import { describe, expect, it } from "vitest";
import {
  createProject,
  getTrustPolicy,
  matchTrust,
  setTrustPolicy,
} from "../src/core/registry/index.ts";
import type { TrustPolicy } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const ISS = "https://token.actions.githubusercontent.com";
const AUD = "scafo";

const POLICY: TrustPolicy = {
  v: 1,
  issuers: [
    {
      iss: ISS,
      aud: AUD,
      subjects: ["repo:sandros94/scafo:ref:refs/heads/main", "repo:sandros94/scafo:pull_request"],
    },
  ],
};

function withSubjects(subjects: string[]): TrustPolicy {
  return { v: 1, issuers: [{ iss: ISS, aud: AUD, subjects }] };
}

describe("matchTrust", () => {
  it("denies when there is no policy at all", () => {
    expect(
      matchTrust(null, { iss: ISS, aud: AUD, sub: "repo:sandros94/scafo:pull_request" }),
    ).toBeNull();
  });

  it("returns the issuer that authorizes the claims", () => {
    const matched = matchTrust(POLICY, {
      iss: ISS,
      aud: AUD,
      sub: "repo:sandros94/scafo:pull_request",
    });
    expect(matched).toEqual(POLICY.issuers[0]);
  });

  it("requires iss and aud to match exactly", () => {
    const sub = "repo:sandros94/scafo:pull_request";

    expect(matchTrust(POLICY, { iss: `${ISS}/`, aud: AUD, sub })).toBeNull();
    expect(matchTrust(POLICY, { iss: ISS, aud: "other", sub })).toBeNull();
    expect(matchTrust(POLICY, { iss: ISS.toUpperCase(), aud: AUD, sub })).toBeNull();
  });

  it("denies a subject none of the patterns cover", () => {
    expect(
      matchTrust(POLICY, { iss: ISS, aud: AUD, sub: "repo:someone/else:pull_request" }),
    ).toBeNull();
    expect(
      matchTrust(POLICY, { iss: ISS, aud: AUD, sub: "repo:sandros94/scafo:ref:refs/heads/dev" }),
    ).toBeNull();
  });

  it("lets * stand for any run of characters, anchored at both ends", () => {
    const policy = withSubjects(["repo:sandros94/scafo:*"]);
    const claims = (sub: string): { iss: string; aud: string; sub: string } => ({
      iss: ISS,
      aud: AUD,
      sub,
    });

    expect(matchTrust(policy, claims("repo:sandros94/scafo:ref:refs/tags/v1"))).not.toBeNull();
    expect(matchTrust(policy, claims("repo:sandros94/scafo:"))).not.toBeNull();
    expect(matchTrust(policy, claims("prefix-repo:sandros94/scafo:x"))).toBeNull();
    expect(matchTrust(policy, claims("repo:sandros94/other:x"))).toBeNull();
  });

  it("treats everything but * as a literal, regex metacharacters included", () => {
    const policy = withSubjects(["repo:a.b/c+d(e)"]);

    expect(matchTrust(policy, { iss: ISS, aud: AUD, sub: "repo:a.b/c+d(e)" })).not.toBeNull();
    expect(matchTrust(policy, { iss: ISS, aud: AUD, sub: "repo:axb/c+d(e)" })).toBeNull();
    expect(matchTrust(policy, { iss: ISS, aud: AUD, sub: "repo:a.b/ccd(e)" })).toBeNull();
  });

  it("lets * span newlines, so a multi-line subject cannot slip past", () => {
    const policy = withSubjects(["repo:sandros94/*:main"]);
    expect(
      matchTrust(policy, { iss: ISS, aud: AUD, sub: "repo:sandros94/sc\nalo:main" }),
    ).not.toBeNull();
  });

  it("takes the first issuer that matches when several could", () => {
    const policy: TrustPolicy = {
      v: 1,
      issuers: [
        { iss: ISS, aud: AUD, subjects: ["nothing-matches"] },
        { iss: ISS, aud: AUD, subjects: ["repo:*"] },
      ],
    };

    expect(matchTrust(policy, { iss: ISS, aud: AUD, sub: "repo:x" })).toEqual(policy.issuers[1]);
  });
});

describe("setTrustPolicy", () => {
  it("creates the policy, then replaces it wholesale", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());
    await createProject(ctx, { slug: PROJECT });

    await expect(setTrustPolicy(ctx, PROJECT, POLICY)).resolves.toEqual(POLICY);
    await expect(getTrustPolicy(ctx, PROJECT)).resolves.toEqual(POLICY);

    const replaced = withSubjects(["repo:sandros94/scafo:*"]);
    await expect(setTrustPolicy(ctx, PROJECT, replaced)).resolves.toEqual(replaced);
    await expect(getTrustPolicy(ctx, PROJECT)).resolves.toEqual(replaced);
  });

  it("throws not-found for a project with no policy", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());
    await createProject(ctx, { slug: PROJECT });

    const error = await rejectsWith(() => getTrustPolicy(ctx, PROJECT), "not-found");
    expect(error.status).toBe(404);
  });
});
