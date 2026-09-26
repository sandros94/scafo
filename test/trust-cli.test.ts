/*
 * `scafo trust`: the operator's half of the workload-deploy path — which CI issuers an
 * application admits, which of their subjects, and what an edit does to the grants already in
 * the policy.
 */

import { describe, expect, it } from "vitest";
import { OIDC_AUDIENCE } from "../src/core/auth/index.ts";
import { type ArgsDef, type CommandDef, parseArgs } from "citty";
import { trust as trustCommand, trustSubjects } from "../src/cli/commands/trust.ts";
import {
  DEFAULT_TRUST_AUDIENCE,
  formatTrustPolicy,
  readTrustPolicy,
  addTrustSubjects,
  removeTrustIssuer,
  setTrustIssuer,
} from "../src/cli/_trust.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { matchTrust } from "../src/core/registry/trust.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, rejectsWith } from "./_helpers.ts";

const APPLICATION = "shop";
const GITHUB = "https://token.actions.githubusercontent.com";
const GITLAB = "https://gitlab.example.com";

const MAIN = "repo:acme/shop:ref:refs/heads/main";
const BRANCHES = "repo:acme/shop:ref:refs/heads/*";
const TAGS = "repo:acme/shop:ref:refs/tags/*";

describe("trusting an issuer", () => {
  it("writes a policy an application had none of, defaulting the audience to ours", async () => {
    const registry = emptyRegistry();

    const policy = await setTrustIssuer(registry, {
      application: APPLICATION,
      iss: GITHUB,
      aud: DEFAULT_TRUST_AUDIENCE,
      subjects: [BRANCHES],
    });

    expect(policy).toEqual({
      v: 1,
      issuers: [{ iss: GITHUB, aud: OIDC_AUDIENCE, subjects: [BRANCHES] }],
    });
    expect(await readTrustPolicy(registry, APPLICATION)).toEqual(policy);
  });

  it("admits exactly the subjects it was given, as the verifier reads them", async () => {
    const registry = emptyRegistry();
    const policy = await setTrustIssuer(registry, {
      application: APPLICATION,
      iss: GITHUB,
      aud: OIDC_AUDIENCE,
      subjects: [BRANCHES],
    });

    expect(matchTrust(policy, { iss: GITHUB, aud: OIDC_AUDIENCE, sub: MAIN })).not.toBeNull();
    expect(
      matchTrust(policy, { iss: GITHUB, aud: OIDC_AUDIENCE, sub: "repo:evil/other:ref:x" }),
    ).toBeNull();
  });

  it("replaces the subjects of the issuer and audience it names, and only those", async () => {
    const registry = emptyRegistry();
    await trust(registry, GITHUB, [BRANCHES, TAGS]);
    await trust(registry, GITLAB, ["project_path:acme/shop:ref_type:branch:ref:main"]);

    const policy = await trust(registry, GITHUB, [MAIN]);

    expect(policy.issuers).toEqual([
      { iss: GITHUB, aud: OIDC_AUDIENCE, subjects: [MAIN] },
      {
        iss: GITLAB,
        aud: OIDC_AUDIENCE,
        subjects: ["project_path:acme/shop:ref_type:branch:ref:main"],
      },
    ]);
  });

  it("appends an issuer the policy does not name yet, keeping the ones it does", async () => {
    const registry = emptyRegistry();
    await trust(registry, GITHUB, [BRANCHES]);

    const policy = await trust(registry, GITLAB, [TAGS]);

    expect(policy.issuers.map((issuer) => issuer.iss)).toEqual([GITHUB, GITLAB]);
    expect(policy.issuers[0].subjects).toEqual([BRANCHES]);
  });

  it("treats one issuer's second audience as a second grant, not an overwrite", async () => {
    const registry = emptyRegistry();
    await trust(registry, GITHUB, [BRANCHES]);

    const policy = await setTrustIssuer(registry, {
      application: APPLICATION,
      iss: GITHUB,
      aud: "staging",
      subjects: [TAGS],
    });

    expect(policy.issuers).toEqual([
      { iss: GITHUB, aud: OIDC_AUDIENCE, subjects: [BRANCHES] },
      { iss: GITHUB, aud: "staging", subjects: [TAGS] },
    ]);
  });

  it("keeps each application's policy to itself", async () => {
    const registry = emptyRegistry();
    await trust(registry, GITHUB, [BRANCHES]);

    await setTrustIssuer(registry, {
      application: "other",
      iss: GITLAB,
      aud: OIDC_AUDIENCE,
      subjects: [TAGS],
    });

    expect((await readTrustPolicy(registry, APPLICATION)).issuers.map((i) => i.iss)).toEqual([
      GITHUB,
    ]);
    expect((await readTrustPolicy(registry, "other")).issuers.map((i) => i.iss)).toEqual([GITLAB]);
  });

  it("refuses an issuer that is not a URL discovery could ever be asked of", async () => {
    const registry = emptyRegistry();

    for (const iss of ["github", "token.actions.githubusercontent.com", "ftp://issuer.test"]) {
      const error = await rejectsWith(() => trust(registry, iss, [BRANCHES]), "invalid-input");
      expect(error.detail, iss).toContain(".well-known/openid-configuration");
    }
  });

  it("refuses an issuer trusted for nothing, which would admit nothing", async () => {
    const registry = emptyRegistry();

    const error = await rejectsWith(() => trust(registry, GITHUB, []), "invalid-input");

    expect(error.detail).toContain("--subject");
  });
});

describe("adding a subject to what an issuer is already trusted for", () => {
  it("keeps every subject the issuer had and appends the new one", async () => {
    const registry = ctxWith(new MemoryCasStore()).ctx;
    await setTrustIssuer(registry, {
      application: APPLICATION,
      iss: GITHUB,
      aud: "scafo",
      subjects: [TAGS],
    });

    const { policy, added } = await addTrustSubjects(registry, {
      application: APPLICATION,
      iss: GITHUB,
      aud: "scafo",
      subjects: [MAIN],
    });

    expect(added).toEqual([MAIN]);
    expect(policy.issuers).toEqual([{ iss: GITHUB, aud: "scafo", subjects: [TAGS, MAIN] }]);
  });

  it("adds nothing twice, and says what it did add", async () => {
    const registry = ctxWith(new MemoryCasStore()).ctx;
    const once = { application: APPLICATION, iss: GITHUB, aud: "scafo", subjects: [MAIN, TAGS] };
    await addTrustSubjects(registry, once);

    const again = await addTrustSubjects(registry, { ...once, subjects: [TAGS, BRANCHES] });

    expect(again.added).toEqual([BRANCHES]);
    expect(again.policy.issuers[0]?.subjects).toEqual([MAIN, TAGS, BRANCHES]);
  });

  it("writes the policy and the issuer when neither is there yet", async () => {
    const registry = ctxWith(new MemoryCasStore()).ctx;

    const { policy } = await addTrustSubjects(registry, {
      application: APPLICATION,
      iss: GITLAB,
      aud: "scafo",
      subjects: [MAIN],
    });

    expect(policy).toEqual({ v: 1, issuers: [{ iss: GITLAB, aud: "scafo", subjects: [MAIN] }] });
  });

  it("refuses an issuer that is no URL and a call that names no subject", async () => {
    const registry = ctxWith(new MemoryCasStore()).ctx;
    const base = { application: APPLICATION, aud: "scafo" };

    await expect(
      addTrustSubjects(registry, { ...base, iss: "github", subjects: [MAIN] }),
    ).rejects.toMatchObject({ code: "invalid-input", message: "Invalid issuer" });
    await expect(
      addTrustSubjects(registry, { ...base, iss: GITHUB, subjects: [] }),
    ).rejects.toMatchObject({ code: "invalid-input", message: "No subject given" });
    /* Refused before anything is written. */
    await expect(readTrustPolicy(registry, APPLICATION)).resolves.toEqual({ v: 1, issuers: [] });
  });
});

describe("two edits of one policy made at once", () => {
  it("keeps both, whichever is written second", async () => {
    const registry = ctxWith(new MemoryCasStore()).ctx;
    await setTrustIssuer(registry, {
      application: APPLICATION,
      iss: GITHUB,
      aud: "scafo",
      subjects: [TAGS],
    });

    await Promise.all([
      addTrustSubjects(registry, {
        application: APPLICATION,
        iss: GITHUB,
        aud: "scafo",
        subjects: [MAIN],
      }),
      setTrustIssuer(registry, {
        application: APPLICATION,
        iss: GITLAB,
        aud: "scafo",
        subjects: [BRANCHES],
      }),
    ]);

    const policy = await readTrustPolicy(registry, APPLICATION);
    expect(policy.issuers.find((issuer) => issuer.iss === GITHUB)?.subjects).toEqual([TAGS, MAIN]);
    expect(policy.issuers.find((issuer) => issuer.iss === GITLAB)?.subjects).toEqual([BRANCHES]);
  });
});

describe("reading the subjects off the flag", () => {
  it.each(["set", "add"])("takes one subject per --subject on `scafo trust %s`", (verb) => {
    const args = ((trustCommand.subCommands as Record<string, CommandDef>)[verb] as CommandDef)
      .args as ArgsDef;
    const parsed = parseArgs(
      ["--name", "shop", "--issuer", GITHUB, "--subject", BRANCHES, `--subject=${TAGS}`],
      args,
    );

    expect(trustSubjects(parsed)).toEqual([BRANCHES, TAGS]);
  });

  it("keeps a comma inside the subject it was written in", () => {
    /* A subject is whatever the issuer minted, and nothing says it holds no
       comma: each occurrence of the flag is one subject, whole. */
    expect(trustSubjects({ subject: ["repo:acme/a,b:ref:main", ` ${MAIN} `] })).toEqual([
      "repo:acme/a,b:ref:main",
      MAIN,
    ]);
  });

  it("reads no subject out of a flag that was not given, or given empty", () => {
    expect(trustSubjects({})).toEqual([]);
    expect(trustSubjects({ subject: [] })).toEqual([]);
    expect(trustSubjects({ subject: ["", "  "] })).toEqual([]);
  });
});

describe("no longer trusting an issuer", () => {
  it("takes it out and leaves the policy behind as an empty one", async () => {
    const registry = emptyRegistry();
    await trust(registry, GITHUB, [BRANCHES]);

    const policy = await removeTrustIssuer(registry, APPLICATION, GITHUB);

    expect(policy).toEqual({ v: 1, issuers: [] });
    expect(await readTrustPolicy(registry, APPLICATION)).toEqual({ v: 1, issuers: [] });
  });

  it("takes every audience that issuer was granted, and no other issuer", async () => {
    const registry = emptyRegistry();
    await trust(registry, GITHUB, [BRANCHES]);
    await setTrustIssuer(registry, {
      application: APPLICATION,
      iss: GITHUB,
      aud: "staging",
      subjects: [TAGS],
    });
    await trust(registry, GITLAB, [MAIN]);

    const policy = await removeTrustIssuer(registry, APPLICATION, GITHUB);

    expect(policy.issuers).toEqual([{ iss: GITLAB, aud: OIDC_AUDIENCE, subjects: [MAIN] }]);
  });

  it("refuses an issuer the application never trusted, naming the ones it does", async () => {
    const registry = emptyRegistry();
    await trust(registry, GITHUB, [BRANCHES]);

    const error = await rejectsWith(
      () => removeTrustIssuer(registry, APPLICATION, GITLAB),
      "not-found",
    );

    expect(error.detail).toContain(GITLAB);
    expect(error.detail).toContain(GITHUB);
  });

  it("refuses on an application with no policy at all, rather than writing an empty one", async () => {
    const registry = emptyRegistry();

    const error = await rejectsWith(
      () => removeTrustIssuer(registry, APPLICATION, GITHUB),
      "not-found",
    );

    expect(error.detail).toContain("no issuer at all");
  });
});

describe("what `scafo trust show` puts on the terminal", () => {
  it("prints every subject verbatim, globs and all, under the audience it was granted for", async () => {
    const registry = emptyRegistry();
    await trust(registry, GITHUB, [BRANCHES, TAGS]);

    const printed = formatTrustPolicy(await readTrustPolicy(registry, APPLICATION));

    expect(printed).toBe(
      [`${GITHUB} (aud ${OIDC_AUDIENCE})`, `  ${BRANCHES}`, `  ${TAGS}`].join("\n"),
    );

    /* The audience is named whichever one it is, because a token minted for
       another one is refused. */
    const staged = emptyRegistry();
    await setTrustIssuer(staged, {
      application: APPLICATION,
      iss: GITHUB,
      aud: "staging",
      subjects: [MAIN],
    });

    expect(formatTrustPolicy(await readTrustPolicy(staged, APPLICATION))).toContain(
      "(aud staging)",
    );
  });

  it("says plainly that an application with no policy admits nothing", async () => {
    const registry = emptyRegistry();

    const printed = formatTrustPolicy(await readTrustPolicy(registry, APPLICATION));

    expect(printed).toContain("no issuer is trusted");
    expect(printed).toContain("no workload token can deploy");
  });
});

function emptyRegistry(): RegistryContext {
  return ctxWith(new MemoryCasStore()).ctx;
}

/** One `scafo trust set` on {@link APPLICATION}, with the default audience. */
function trust(
  registry: RegistryContext,
  iss: string,
  subjects: string[],
): ReturnType<typeof setTrustIssuer> {
  return setTrustIssuer(registry, { application: APPLICATION, iss, aud: OIDC_AUDIENCE, subjects });
}
