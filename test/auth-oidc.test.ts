/* Trust failures are `trust-mismatch`; token failures are `auth-invalid`. */

import type { JWK_RSA_Private, JWK_RSA_Public, JWKSet } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { sign as signJws } from "unjwt/jws";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOidcVerifier, OIDC_AUDIENCE, type OidcVerifier } from "../src/core/auth/index.ts";
import type { ScafoError } from "../src/core/error.ts";
import { createProject, setTrustPolicy } from "../src/core/registry/index.ts";
import type { TrustPolicy } from "../src/core/types/registry.ts";
import { fromBase64Url, toBase64Url } from "../src/core/utils/base64.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectionOf } from "./_helpers.ts";

interface IssuerKeys {
  privateKey: JWK_RSA_Private<"RS256">;
  publicKey: JWK_RSA_Public<"RS256">;
}

const ISS = "https://issuer.test";
const DISCOVERY_URL = `${ISS}/.well-known/openid-configuration`;
const JWKS_URL = `${ISS}/keys.json`;
const KID = "issuer-key-1";

/** The project whose policy trusts {@link ISS}. */
const TRUSTING = "pro-a";
/** No trust policy at all. */
const UNCONFIGURED = "pro-b";
/** A policy that names a different issuer. */
const OTHER_ISSUER = "pro-c";

const SUBJECT = "repo:acme/app:ref:refs/heads/main";
const SUBJECT_GLOB = "repo:acme/app:ref:refs/heads/*";
const SKEW_S = 30;
const JWKS_TTL_S = 300;

/** Authentication failed: one code, one message, nothing a caller can tell apart. */
const AUTH_INVALID = {
  code: "auth-invalid",
  status: 401,
  message: "Authentication failed",
  detail: undefined,
};

/** Authorization failed, which the caller is allowed to distinguish. */
const TRUST_MISMATCH = {
  code: "trust-mismatch",
  status: 403,
  message: "Trust policy does not admit this token",
  detail: expect.any(String),
};

let keys: IssuerKeys;
let clock: ManualClock;
let verifier: OidcVerifier;
let calls: string[];
let discoveryDoc: unknown;
let jwksDoc: unknown;

beforeAll(async () => {
  keys = await generateJWK("RS256", { kid: KID });
});

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  calls = [];
  discoveryDoc = { issuer: ISS, jwks_uri: JWKS_URL };
  jwksDoc = { keys: [keys.publicKey] } satisfies JWKSet;

  for (const project of [TRUSTING, UNCONFIGURED, OTHER_ISSUER]) {
    await createProject(clock.ctx, { slug: project });
  }
  await setTrustPolicy(clock.ctx, TRUSTING, policyFor(ISS, [SUBJECT_GLOB]));
  await setTrustPolicy(clock.ctx, OTHER_ISSUER, policyFor("https://elsewhere.test", ["repo:*"]));

  verifier = createOidcVerifier(clock.ctx, { now: now, fetchFn: fetchFn, jwksTtlS: JWKS_TTL_S });
});

describe("a token the policy admits", () => {
  it("resolves the workload's identity and the policy entry that admitted it", async () => {
    const identity = await verifier.verify(await mint(), TRUSTING);

    expect(identity).toEqual({
      actor: { issuer: ISS, subject: SUBJECT },
      project: TRUSTING,
      issuer: { iss: ISS, aud: OIDC_AUDIENCE, subjects: [SUBJECT_GLOB] },
    });
    expect(calls).toEqual([DISCOVERY_URL, JWKS_URL]);
  });

  it("accepts an aud array that names us, and only then", async () => {
    await expect(
      verifier.verify(await mint({ aud: [OIDC_AUDIENCE, "other"] }), TRUSTING),
    ).resolves.toMatchObject({ actor: { subject: SUBJECT } });

    expect(await refusal(await mint({ aud: ["other", "third"] }))).toMatchObject(AUTH_INVALID);
    expect(await refusal(await mint({ aud: [] }))).toMatchObject(AUTH_INVALID);
  });

  it("takes the audience from the grant, not from a platform-wide default", async () => {
    await setTrustPolicy(clock.ctx, TRUSTING, {
      v: 1,
      issuers: [{ iss: ISS, aud: "staging", subjects: [SUBJECT_GLOB] }],
    });

    await expect(verifier.verify(await mint({ aud: "staging" }), TRUSTING)).resolves.toMatchObject({
      issuer: { aud: "staging" },
    });
    /* The default audience is what the CLI writes, not what a policy means. */
    expect(await refusal(await mint())).toMatchObject(AUTH_INVALID);
  });

  it("admits a token under whichever of its audiences the grant names", async () => {
    await setTrustPolicy(clock.ctx, TRUSTING, {
      v: 1,
      issuers: [
        { iss: ISS, aud: "staging", subjects: ["repo:acme/app:ref:refs/tags/*"] },
        { iss: ISS, aud: "production", subjects: [SUBJECT_GLOB] },
      ],
    });

    await expect(
      verifier.verify(await mint({ aud: ["staging", "production"] }), TRUSTING),
    ).resolves.toMatchObject({ issuer: { aud: "production", subjects: [SUBJECT_GLOB] } });
  });

  it("accepts an nbf that has already passed", async () => {
    await expect(
      verifier.verify(await mint({ nbf: nowS() - 10 }), TRUSTING),
    ).resolves.toMatchObject({ actor: { subject: SUBJECT } });
  });
});

describe("trust is checked before anything is fetched", () => {
  it("refuses a project with no trust policy without a single request", async () => {
    expect(await refusal(await mint(), UNCONFIGURED)).toMatchObject(AUTH_INVALID);
    expect(calls).toEqual([]);
  });

  it("refuses an issuer the project does not name, without a single request", async () => {
    /* SSRF guard: the token picks the URL, so nothing may be fetched until the
       project's own policy has named that issuer. */
    expect(await refusal(await mint(), OTHER_ISSUER)).toMatchObject(AUTH_INVALID);
    expect(await refusal(await mint({ iss: "http://169.254.169.254" }))).toMatchObject(
      AUTH_INVALID,
    );
    expect(calls).toEqual([]);
  });

  it("refuses a subject outside the policy's globs, signature notwithstanding", async () => {
    const token = await mint({ sub: "repo:evil/app:ref:refs/heads/main" });

    expect(await refusal(token)).toMatchObject(TRUST_MISMATCH);
    /* The signature was checked first: the issuer was reached, then denied. */
    expect(calls).toEqual([DISCOVERY_URL, JWKS_URL]);
  });
});

describe("subject glob semantics", () => {
  it("lets * span a path, but not the segment before it", async () => {
    await expect(
      verifier.verify(await mint({ sub: "repo:acme/app:ref:refs/heads/feat/x" }), TRUSTING),
    ).resolves.toMatchObject({ actor: { subject: "repo:acme/app:ref:refs/heads/feat/x" } });

    expect(await refusal(await mint({ sub: "repo:acme/app:ref:refs/tags/v1" }))).toMatchObject(
      TRUST_MISMATCH,
    );
  });

  it("keeps regex metacharacters literal", async () => {
    await setTrustPolicy(clock.ctx, TRUSTING, policyFor(ISS, ["repo:a.b/c+d(e)"]));

    await expect(
      verifier.verify(await mint({ sub: "repo:a.b/c+d(e)" }), TRUSTING),
    ).resolves.toMatchObject({ actor: { subject: "repo:a.b/c+d(e)" } });

    expect(await refusal(await mint({ sub: "repo:axb/c+d(e)" }))).toMatchObject(TRUST_MISMATCH);
    expect(await refusal(await mint({ sub: "repo:a.b/ccd(e)" }))).toMatchObject(TRUST_MISMATCH);
  });
});

describe("a token that does not hold up is just auth-invalid", () => {
  it("refuses a token minted for another audience", async () => {
    expect(await refusal(await mint({ aud: "other-platform" }))).toMatchObject(AUTH_INVALID);
    expect(await refusal(await mint({ aud: OIDC_AUDIENCE.toUpperCase() }))).toMatchObject(
      AUTH_INVALID,
    );
  });

  it("refuses a token outside its validity window", async () => {
    const expired = await mint({ iat: nowS() - 100, exp: nowS() - SKEW_S - 1 });

    expect(await refusal(expired)).toMatchObject(AUTH_INVALID);
    expect(await refusal(await mint({ iat: nowS() + SKEW_S + 1 }))).toMatchObject(AUTH_INVALID);
    expect(await refusal(await mint({ nbf: nowS() + SKEW_S + 1 }))).toMatchObject(AUTH_INVALID);
  });

  it("refuses an unsigned alg:none token", async () => {
    const header = jsonSegment({ alg: "none", kid: KID });

    expect(await refusal(`${header}.${jsonSegment(claims())}.`)).toMatchObject(AUTH_INVALID);
  });

  it("refuses a token whose payload or signature was edited after signing", async () => {
    const [header = "", payload = "", signature = ""] = (await mint()).split(".");
    const edited = jsonSegment({ ...claims(), sub: "repo:evil/app" });

    expect(await refusal(`${header}.${payload}.${flipFirstByte(signature)}`)).toMatchObject(
      AUTH_INVALID,
    );
    expect(await refusal(`${header}.${edited}.${signature}`)).toMatchObject(AUTH_INVALID);
  });

  it("refuses a token signed by a key the issuer does not publish", async () => {
    const rogue: IssuerKeys = await generateJWK("RS256", { kid: KID });
    const token = await signJws(claims(), rogue.privateKey, {
      alg: "RS256",
      protectedHeader: { kid: KID },
    });

    expect(await refusal(token)).toMatchObject(AUTH_INVALID);
  });

  it("refuses a token whose kid is in no published key set", async () => {
    expect(await refusal(await mint({}, "unknown-kid"))).toMatchObject(AUTH_INVALID);
  });

  it("refuses when discovery itself fails", async () => {
    discoveryDoc = null;
    expect(await refusal(await mint())).toMatchObject(AUTH_INVALID);

    discoveryDoc = { issuer: ISS };
    expect(await refusal(await mint())).toMatchObject(AUTH_INVALID);

    discoveryDoc = { issuer: ISS, jwks_uri: "file:///etc/passwd" };
    expect(await refusal(await mint())).toMatchObject(AUTH_INVALID);
    /* Whatever the discovery document says, nothing but http(s) is fetched. */
    expect(calls).toEqual([DISCOVERY_URL]);
  });

  it("refuses when the key set is not a key set", async () => {
    jwksDoc = { oops: true };

    expect(await refusal(await mint())).toMatchObject(AUTH_INVALID);
  });

  it("refuses garbage that is not a compact JWS", async () => {
    for (const token of ["", "a.b", "a.b.c", "a.b.c.d", "!!!.???.$$$"]) {
      expect(await refusal(token), `for ${JSON.stringify(token)}`).toMatchObject(AUTH_INVALID);
    }
    expect(calls).toEqual([]);
  });
});

describe("the JWKS cache", () => {
  it.each([
    { jwksCacheEntries: 0 },
    { jwksCacheEntries: -1 },
    { jwksCacheEntries: Number.NaN },
    { jwksCacheEntries: Number.POSITIVE_INFINITY },
    { jwksFailureTtlS: -1 },
    { jwksFailureTtlS: Number.NaN },
    { jwksFailureTtlS: Number.POSITIVE_INFINITY },
    { jwksTimeoutS: 0 },
    { jwksTimeoutS: -1 },
    { jwksTimeoutS: Number.NaN },
    { jwksTimeoutS: Number.POSITIVE_INFINITY },
  ])("refuses an invalid public cache option: %o", (options) => {
    expect(() => createOidcVerifier(clock.ctx, { now, fetchFn, ...options })).toThrowError(
      expect.objectContaining({ code: "invalid-input" }),
    );
  });

  it("discovers once per TTL, then refetches", async () => {
    const token = await mint();

    await verifier.verify(token, TRUSTING);
    await verifier.verify(token, TRUSTING);
    expect(calls).toEqual([DISCOVERY_URL, JWKS_URL]);

    clock.tick((JWKS_TTL_S + 1) * 1000);
    await verifier.verify(token, TRUSTING);
    expect(calls).toEqual([DISCOVERY_URL, JWKS_URL, DISCOVERY_URL, JWKS_URL]);
  });

  it("abandons an issuer that takes the request and then says nothing", async () => {
    const reasons: unknown[] = [];
    verifier = createOidcVerifier(clock.ctx, {
      now,
      jwksTimeoutS: 0.05,
      fetchFn: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reasons.push(init.signal?.reason);
              reject(init.signal?.reason as Error);
            },
            { once: true },
          );
        }),
    });

    expect(await refusal(await mint())).toMatchObject(AUTH_INVALID);
    /* The request itself is cancelled, not just given up on. */
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({ name: "TimeoutError" });
  });

  it("coalesces concurrent discovery and key-set requests for one issuer", async () => {
    const token = await mint();

    await Promise.all(Array.from({ length: 12 }, () => verifier.verify(token, TRUSTING)));

    expect(calls).toEqual([DISCOVERY_URL, JWKS_URL]);
  });

  it("backs off failed discovery and evicts old negative entries", async () => {
    const issuers = ["https://issuer-a.test", "https://issuer-b.test", "https://issuer-c.test"];
    await setTrustPolicy(clock.ctx, TRUSTING, {
      v: 1,
      issuers: issuers.map((iss) => ({ iss, aud: OIDC_AUDIENCE, subjects: [SUBJECT_GLOB] })),
    });
    discoveryDoc = null;
    verifier = createOidcVerifier(clock.ctx, {
      now,
      fetchFn,
      jwksCacheEntries: 2,
      jwksFailureTtlS: 60,
    });

    const one = await mint({ iss: issuers[0] });
    await refusal(one);
    await refusal(one);
    expect(calls).toEqual([`${issuers[0]}/.well-known/openid-configuration`]);

    await refusal(await mint({ iss: issuers[1] }));
    await refusal(await mint({ iss: issuers[2] }));
    await refusal(one);
    expect(calls).toHaveLength(4);
  });

  it("refuses a distinct issuer locally while every bounded entry is fetching", async () => {
    const issuers = ["https://issuer-a.test", "https://issuer-b.test", "https://issuer-c.test"];
    await setTrustPolicy(clock.ctx, TRUSTING, {
      v: 1,
      issuers: issuers.map((iss) => ({ iss, aud: OIDC_AUDIENCE, subjects: [SUBJECT_GLOB] })),
    });

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    verifier = createOidcVerifier(clock.ctx, {
      now,
      jwksCacheEntries: 2,
      fetchFn(input) {
        const url =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
        started.push(url);
        return gate.then(() => {
          const issuer = url.replace(/\/.well-known\/openid-configuration$/, "");
          const body = url.endsWith("/.well-known/openid-configuration")
            ? { issuer, jwks_uri: `${issuer}/keys.json` }
            : ({ keys: [keys.publicKey] } satisfies JWKSet);
          return new Response(JSON.stringify(body));
        });
      },
    });

    const first = verifier.verify(await mint({ iss: issuers[0] }), TRUSTING);
    const second = verifier.verify(await mint({ iss: issuers[1] }), TRUSTING);
    await vi.waitFor(() => expect(started).toHaveLength(2));

    expect(await refusal(await mint({ iss: issuers[2] }))).toMatchObject(AUTH_INVALID);
    expect(started).toHaveLength(2);

    release?.();
    await Promise.all([first, second]);
  });
});

function now(): Date {
  return new Date(clock.nowMs());
}

function nowS(): number {
  return Math.floor(clock.nowMs() / 1000);
}

function policyFor(iss: string, subjects: string[]): TrustPolicy {
  return { v: 1, issuers: [{ iss, aud: OIDC_AUDIENCE, subjects }] };
}

function claims(overrides?: Record<string, unknown>): Record<string, unknown> {
  const iat = nowS();
  return { iss: ISS, aud: OIDC_AUDIENCE, sub: SUBJECT, iat, exp: iat + 3600, ...overrides };
}

function mint(overrides?: Record<string, unknown>, kid: string = KID): Promise<string> {
  return signJws(claims(overrides), keys.privateKey, { alg: "RS256", protectedHeader: { kid } });
}

function refusal(token: string, project: string = TRUSTING): Promise<ScafoError> {
  return rejectionOf(() => verifier.verify(token, project));
}

/** Serves the issuer's discovery document and key set, logging every URL asked for. */
function fetchFn(input: RequestInfo | URL): Promise<Response> {
  const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
  calls.push(url);

  const body = url === DISCOVERY_URL ? discoveryDoc : url === JWKS_URL ? jwksDoc : null;
  if (body === null) return Promise.resolve(new Response("no such document", { status: 404 }));
  return Promise.resolve(new Response(JSON.stringify(body)));
}

function jsonSegment(value: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/*
 * Flips a bit of the decoded bytes, not of the base64url text: a signature's
 * last character carries padding bits, so editing it can be a no-op.
 */
function flipFirstByte(segment: string): string {
  const bytes = fromBase64Url(segment);
  bytes[0] ^= 0x01;
  return toBase64Url(bytes);
}
