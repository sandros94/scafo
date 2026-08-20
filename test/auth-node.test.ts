/*
 * Every rejected node token fails identically, whatever was wrong with it, and
 * a deregistered node keeps verifying for at most the key-cache TTL.
 */

import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { sign as signJws } from "unjwt/jws";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createNodeVerifier,
  NODE_TOKEN_AUDIENCE,
  NODE_TOKEN_MAX_LIFETIME_S,
  type NodeVerifier,
  signNodeToken,
} from "../src/core/auth/index.ts";
import {
  acquireLease,
  type LeaseHandle,
  registerNode,
  removeNode,
} from "../src/core/registry/index.ts";
import type { ScafoError } from "../src/core/error.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import { fromBase64Url, toBase64Url } from "../src/core/utils/base64.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectionOf } from "./_helpers.ts";

interface NodeKeys {
  privateKey: JWK_OKP_Private<"EdDSA">;
  publicKey: JWK_OKP_Public<"EdDSA">;
}

const NODE_ID = "node-a";
const OTHER_ID = "node-b";
/** The verifier's default clock skew; every window vector is built relative to it. */
const SKEW_S = 30;

/**
 * The single rejection every bad token has to be indistinguishable from: one
 * code, one message, no detail. The reason only ever travels in `cause`.
 */
const AUTH_INVALID = {
  code: "auth-invalid",
  status: 401,
  message: "Authentication failed",
  detail: undefined,
};

let clock: ManualClock;
let keys: NodeKeys;
let verifier: NodeVerifier;
let minted = 0;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  keys = await generateJWK("EdDSA", { kid: NODE_ID });
  await registerNode(clock.ctx, nodeRecord(NODE_ID, keys.publicKey.x));
  verifier = createNodeVerifier(clock.ctx, { now: now });
  minted = 0;
});

describe("signNodeToken", () => {
  it("mints a token this node's verifier accepts", async () => {
    const identity = await verifier.verify(await mint());

    expect(identity.nodeId).toBe(NODE_ID);
    expect(identity.claims).toMatchObject({ sub: NODE_ID, aud: NODE_TOKEN_AUDIENCE });
    expect(identity.claims.exp - identity.claims.iat).toBe(NODE_TOKEN_MAX_LIFETIME_S);
    expect(identity.claims.jti.length).toBeGreaterThan(0);
  });

  it("refuses to mint a token that outlives the ceiling", async () => {
    for (const lifetimeS of [NODE_TOKEN_MAX_LIFETIME_S + 1, 3600, 0, -1, Number.NaN]) {
      const error = await rejectionOf(() => signNodeToken(keys.privateKey, NODE_ID, { lifetimeS }));
      expect(error.code, `for lifetimeS ${String(lifetimeS)}`).toBe("invalid-input");
    }

    await expect(
      signNodeToken(keys.privateKey, NODE_ID, { lifetimeS: NODE_TOKEN_MAX_LIFETIME_S }),
    ).resolves.toBeTypeOf("string");
  });

  it("refuses a key that cannot be imported as an Ed25519 private key", async () => {
    const error = await rejectionOf(() => signNodeToken({ ...keys.publicKey, d: "AAAA" }, NODE_ID));

    expect(error.code).toBe("invalid-input");
  });
});

describe("every bad node token is answered with the same rejection", () => {
  it("hides the reason in cause, and nowhere a caller can read it", async () => {
    const error = await refusal(await forge({ ...baseClaims(), aud: "scafo" }));

    expect(error).toMatchObject(AUTH_INVALID);
    expect(error.toProblem()).toEqual({
      type: "urn:scafo:auth-invalid",
      title: "Authentication failed",
      status: 401,
    });
    expect((error.cause as Error).message).toContain("aud");
  });

  it("refuses an expired token", async () => {
    const token = await mint();
    clock.tick((NODE_TOKEN_MAX_LIFETIME_S + SKEW_S + 1) * 1000);

    expect(await refusal(token)).toMatchObject(AUTH_INVALID);
  });

  it("refuses a token issued in the future", async () => {
    const iat = nowS() + SKEW_S + 1;

    expect(await refusal(await forge({ ...baseClaims(), iat, exp: iat + 30 }))).toMatchObject(
      AUTH_INVALID,
    );
  });

  it("refuses a hand-signed token whose lifetime exceeds the ceiling", async () => {
    const iat = nowS();

    expect(await refusal(await forge({ ...baseClaims(), iat, exp: iat + 3600 }))).toMatchObject(
      AUTH_INVALID,
    );
  });

  it("refuses a token minted for another audience", async () => {
    for (const aud of ["scafo", NODE_TOKEN_AUDIENCE.toUpperCase(), "", 1]) {
      expect(await refusal(await forge({ ...baseClaims(), aud }))).toMatchObject(AUTH_INVALID);
    }
  });

  it("refuses a key id no node was ever registered under", async () => {
    const token = await signNodeToken(keys.privateKey, OTHER_ID, { now: now });

    expect(await refusal(token)).toMatchObject(AUTH_INVALID);
  });

  it("refuses a key id that is not even a legal node id", async () => {
    /* invalid-slug must not escape the registry lookup as a code of its own. */
    const token = await forge({ ...baseClaims(), sub: "NOT A NODE" }, "NOT A NODE");

    expect(await refusal(token)).toMatchObject(AUTH_INVALID);
  });

  it("refuses a token whose sub does not match its key id", async () => {
    expect(await refusal(await forge({ ...baseClaims(), sub: OTHER_ID }))).toMatchObject(
      AUTH_INVALID,
    );
  });

  it("refuses a token without a usable jti", async () => {
    const iat = nowS();
    const withoutJti = { sub: NODE_ID, aud: NODE_TOKEN_AUDIENCE, iat, exp: iat + 30 };

    expect(await refusal(await forge(withoutJti))).toMatchObject(AUTH_INVALID);
    expect(await refusal(await forge({ ...baseClaims(), jti: 42 }))).toMatchObject(AUTH_INVALID);
    expect(await refusal(await forge({ ...baseClaims(), jti: "" }))).toMatchObject(AUTH_INVALID);
  });

  it("refuses a replayed token, even well inside its window", async () => {
    const token = await mint();

    await expect(verifier.verify(token)).resolves.toMatchObject({ nodeId: NODE_ID });
    expect(await refusal(token)).toMatchObject(AUTH_INVALID);

    clock.tick(1000);
    expect(await refusal(token)).toMatchObject(AUTH_INVALID);
  });

  it("refuses an unsigned alg:none token", async () => {
    const claims = baseClaims();
    const header = jsonSegment({ alg: "none", kid: NODE_ID });
    /* Gluing a real signature onto the none-header changes nothing. */
    const stolen = (await mint()).split(".")[2] ?? "";

    expect(await refusal(`${header}.${jsonSegment(claims)}.`)).toMatchObject(AUTH_INVALID);
    expect(await refusal(`${header}.${jsonSegment(claims)}.${stolen}`)).toMatchObject(AUTH_INVALID);
  });

  it("refuses an HS256 token keyed on the node's own public key bytes", async () => {
    /* Key confusion: a verifier that trusted the header would HMAC-check the
       published verification key and accept whatever the attacker signed. */
    const token = await signJws(baseClaims(), fromBase64Url(keys.publicKey.x), {
      alg: "HS256",
      protectedHeader: { kid: NODE_ID },
    });

    expect(await refusal(token)).toMatchObject(AUTH_INVALID);
  });

  it("refuses a token whose payload or signature was edited after signing", async () => {
    const [header = "", payload = "", signature = ""] = (await mint()).split(".");
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Record<
      string,
      unknown
    >;
    const edited = jsonSegment({ ...claims, jti: "borrowed-jti" });

    expect(await refusal(`${header}.${edited}.${signature}`)).toMatchObject(AUTH_INVALID);
    expect(await refusal(`${header}.${payload}.${flipFirstByte(signature)}`)).toMatchObject(
      AUTH_INVALID,
    );
  });

  it("refuses garbage that is not a token at all", async () => {
    const notJson = toBase64Url(new TextEncoder().encode("not json at all"));

    for (const token of [
      "",
      ".",
      "a.b",
      "a.b.c",
      "a.b.c.d",
      `${notJson}.${notJson}.`,
      `${jsonSegment([1, 2, 3])}.${jsonSegment(baseClaims())}.`,
      `${jsonSegment({ alg: "EdDSA", kid: NODE_ID })}.${jsonSegment("a string payload")}.`,
      "!!!.???.$$$",
    ]) {
      expect(await refusal(token), `for ${JSON.stringify(token)}`).toMatchObject(AUTH_INVALID);
    }
  });
});

describe("a removed node stops verifying within the key-cache TTL", () => {
  it("keeps accepting fresh tokens for the TTL window, then stops", async () => {
    await expect(verifier.verify(await mint())).resolves.toMatchObject({ nodeId: NODE_ID });
    await removeRegisteredNode();

    /* The contract is a ≤60s bound, not instant revocation: mid-window the
       cached key still verifies a token minted after the node was removed. */
    clock.tick(30_000);
    await expect(verifier.verify(await mint())).resolves.toMatchObject({ nodeId: NODE_ID });

    clock.tick(31_000);
    expect(await refusal(await mint())).toMatchObject(AUTH_INVALID);
  });

  it("accepts the node again once a re-registration outlives the negative cache", async () => {
    await removeRegisteredNode();

    clock.tick(61_000);
    expect(await refusal(await mint())).toMatchObject(AUTH_INVALID);

    await registerNode(clock.ctx, nodeRecord(NODE_ID, keys.publicKey.x));
    expect(await refusal(await mint())).toMatchObject(AUTH_INVALID);

    clock.tick(61_000);
    await expect(verifier.verify(await mint())).resolves.toMatchObject({ nodeId: NODE_ID });
  });

  it("honours a shorter TTL as a tighter revocation bound", async () => {
    const tight = createNodeVerifier(clock.ctx, { now: now, keyTtlS: 5 });
    await expect(tight.verify(await mint())).resolves.toMatchObject({ nodeId: NODE_ID });
    await removeRegisteredNode();

    clock.tick(6000);
    expect(await rejectionOf(async () => tight.verify(await mint()))).toMatchObject(AUTH_INVALID);
  });
});

function now(): Date {
  return new Date(clock.nowMs());
}

function nowS(): number {
  return Math.floor(clock.nowMs() / 1000);
}

function nodeRecord(id: string, x: string): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x },
    addresses: { internal: "10.0.0.1", agentPort: 4600 },
  };
}

function baseClaims(): Record<string, unknown> {
  const iat = nowS();
  minted++;
  return {
    sub: NODE_ID,
    aud: NODE_TOKEN_AUDIENCE,
    iat,
    exp: iat + 30,
    jti: `jti-${String(iat)}-${String(minted)}`,
  };
}

function mint(): Promise<string> {
  return signNodeToken(keys.privateKey, NODE_ID, { now: now });
}

/** Signs claims the minter would never produce, leaving the verifier as the only guard. */
function forge(claims: Record<string, unknown>, kid: string = NODE_ID): Promise<string> {
  return signJws(claims, keys.privateKey, { alg: "EdDSA", protectedHeader: { kid } });
}

function refusal(token: string): Promise<ScafoError> {
  return rejectionOf(() => verifier.verify(token));
}

async function removeRegisteredNode(): Promise<void> {
  const lease = await acquireLease(clock.ctx, "coordinator");
  expect(lease, "expected to hold the coordinator lease").not.toBeNull();
  await removeNode(clock.ctx, NODE_ID, lease as LeaseHandle);
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
