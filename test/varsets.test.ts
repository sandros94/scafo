/* Varsets travel sealed, and nothing about their contents leaks from what is stored. */

import { describe, expect, it } from "vitest";
import {
  createProject,
  describeVarset,
  getVarsetEnvelope,
  importVarsetKey,
  openVarset,
  putVarset,
  sealVarset,
} from "../src/core/registry/index.ts";
import { varsetKey } from "../src/core/registry/paths.ts";
import type { PlainVarset, VarsetEnvelope } from "../src/core/types/registry.ts";
import { sha256Hex } from "../src/core/utils/hash.ts";
import { stableStringify } from "../src/core/utils/json.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";

const PLAIN: PlainVarset = {
  SUPERSECRET_MARKER_NAME: { value: "SUPERSECRET_MARKER_VALUE", secret: true },
  PUBLIC_MARKER_NAME: { value: "PUBLIC_MARKER_VALUE", secret: false },
  UNICODE_MARKER_NAME: { value: "héllo-wörld-🌍-ünïcode", secret: true },
  EMPTY_MARKER_NAME: { value: "", secret: true },
};

function freshKey(): Promise<CryptoKey> {
  return importVarsetKey(crypto.getRandomValues(new Uint8Array(32)));
}

describe("seal / open", () => {
  it("round-trips a multi-key map, unicode included", async () => {
    const key = await freshKey();
    const sealed = await sealVarset(PLAIN, key);

    await expect(openVarset(sealed.envelope, key)).resolves.toEqual(PLAIN);
    expect(sealed.envelope).toMatchObject({ v: 1, alg: "A256GCM" });
  });

  it("derives the id from the stored bytes, which anyone can verify", async () => {
    const key = await freshKey();
    const sealed = await sealVarset(PLAIN, key);

    await expect(sha256Hex(stableStringify(sealed.envelope))).resolves.toBe(sealed.id);
    expect(sealed.id).toMatch(/^[a-f\d]{64}$/);
  });

  it("seals the same plaintext to different ids, since the IV is random", async () => {
    const key = await freshKey();
    const first = await sealVarset(PLAIN, key);
    const second = await sealVarset(PLAIN, key);

    expect(second.id).not.toBe(first.id);
    expect(second.envelope.iv).not.toBe(first.envelope.iv);
  });

  it("rejects a key that is not 32 bytes", async () => {
    const error = await rejectsWith(
      () => importVarsetKey(crypto.getRandomValues(new Uint8Array(16))),
      "invalid-varset",
    );
    expect(error.status).toBe(400);
  });

  it("rejects the wrong key", async () => {
    const sealed = await sealVarset(PLAIN, await freshKey());
    const other = await freshKey();

    const error = await rejectsWith(() => openVarset(sealed.envelope, other), "invalid-varset");
    expect(error.detail).toContain("wrong key");
  });

  it("rejects a tampered ciphertext", async () => {
    const key = await freshKey();
    const sealed = await sealVarset(PLAIN, key);
    const head = sealed.envelope.ct.slice(0, 1);
    const tampered = {
      ...sealed.envelope,
      ct: (head === "A" ? "B" : "A") + sealed.envelope.ct.slice(1),
    };

    const error = await rejectsWith(() => openVarset(tampered, key), "invalid-varset");
    expect(error.status).toBe(400);
  });

  it("rejects an envelope of an unknown version or algorithm", async () => {
    const key = await freshKey();
    const sealed = await sealVarset(PLAIN, key);
    const forged = (patch: Record<string, unknown>): VarsetEnvelope =>
      ({ ...sealed.envelope, ...patch }) as unknown as VarsetEnvelope;

    const wrongVersion = await rejectsWith(
      () => openVarset(forged({ v: 2 }), key),
      "invalid-varset",
    );
    expect(wrongVersion.detail).toContain("v 2");

    const wrongAlg = await rejectsWith(
      () => openVarset(forged({ alg: "A128GCM" }), key),
      "invalid-varset",
    );
    expect(wrongAlg.detail).toContain("A128GCM");
  });
});

describe("the sealed envelope", () => {
  it("leaks neither key names nor values, in memory or in the bucket", async () => {
    const store = new MemoryCasStore();
    const { ctx } = ctxWith(store);
    await createProject(ctx, { slug: PROJECT });

    const sealed = await sealVarset(PLAIN, await freshKey());
    await putVarset(ctx, PROJECT, sealed);

    const stored = await store.get(varsetKey(PROJECT, sealed.id));
    const haystacks = [JSON.stringify(sealed.envelope), stored?.body ?? ""];
    const markers = [
      ...Object.keys(PLAIN),
      ...Object.values(PLAIN).map((entry) => entry.value),
    ].filter((marker) => marker.length > 0);

    expect(markers.length).toBeGreaterThan(0);
    for (const haystack of haystacks) {
      expect(haystack).not.toBe("");
      for (const marker of markers) expect(haystack).not.toContain(marker);
    }
  });

  it("is what getVarsetEnvelope hands back, byte for byte", async () => {
    const store = new MemoryCasStore();
    const { ctx } = ctxWith(store);
    await createProject(ctx, { slug: PROJECT });

    const key = await freshKey();
    const sealed = await sealVarset(PLAIN, key);
    await putVarset(ctx, PROJECT, sealed);

    const envelope = await getVarsetEnvelope(ctx, PROJECT, sealed.id);
    expect(envelope).toEqual(sealed.envelope);
    await expect(openVarset(envelope, key)).resolves.toEqual(PLAIN);
  });
});

describe("describeVarset", () => {
  it("omits secret values outright rather than masking them", () => {
    const described = describeVarset(PLAIN);

    expect("value" in described.SUPERSECRET_MARKER_NAME).toBe(false);
    expect(described.SUPERSECRET_MARKER_NAME).toEqual({ secret: true });
    expect("value" in described.PUBLIC_MARKER_NAME).toBe(true);
    expect(described.PUBLIC_MARKER_NAME).toEqual({
      secret: false,
      value: "PUBLIC_MARKER_VALUE",
    });
    expect(Object.keys(described).sort()).toEqual(Object.keys(PLAIN).sort());
  });
});

describe("putVarset", () => {
  it("is idempotent for the same bytes", async () => {
    const store = new MemoryCasStore();
    const { ctx } = ctxWith(store);
    await createProject(ctx, { slug: PROJECT });

    const sealed = await sealVarset(PLAIN, await freshKey());
    await putVarset(ctx, PROJECT, sealed);
    const before = await store.get(varsetKey(PROJECT, sealed.id));

    await expect(putVarset(ctx, PROJECT, sealed)).resolves.toBeUndefined();
    await expect(store.get(varsetKey(PROJECT, sealed.id))).resolves.toEqual(before);
  });

  it("refuses different bytes under an id that is already taken", async () => {
    const store = new MemoryCasStore();
    const { ctx } = ctxWith(store);
    await createProject(ctx, { slug: PROJECT });

    const key = await freshKey();
    const first = await sealVarset(PLAIN, key);
    const second = await sealVarset(PLAIN, key);
    await putVarset(ctx, PROJECT, first);

    await rejectsWith(
      () => putVarset(ctx, PROJECT, { id: first.id, envelope: second.envelope }),
      "immutable",
    );
    await expect(getVarsetEnvelope(ctx, PROJECT, first.id)).resolves.toEqual(first.envelope);
  });

  it("throws not-found for a varset that was never stored", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());
    await createProject(ctx, { slug: PROJECT });

    const error = await rejectsWith(() => getVarsetEnvelope(ctx, PROJECT, "deadbeef"), "not-found");
    expect(error.status).toBe(404);
  });
});
