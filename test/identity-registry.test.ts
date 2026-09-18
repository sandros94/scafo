/* The single reservation object is the atomic boundary between node and operator identities. */

import { describe, expect, it } from "vitest";
import { readJson } from "../src/core/registry/cas.ts";
import { registerNode } from "../src/core/registry/nodes.ts";
import {
  revokeOperator,
  trustOperator,
  type TrustedOperator,
} from "../src/core/registry/operators.ts";
import { identityKey, nodeKey, operatorKey } from "../src/core/registry/paths.ts";
import type { IdentityReservation, NodeRecord } from "../src/core/types/registry.ts";
import type {
  ByteRange,
  CasHeaders,
  CasStore,
  StoredEntry,
  StoredObject,
} from "../src/core/types/store.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, rejectsWith } from "./_helpers.ts";

const ID = "identity-a";

describe("identity reservations", () => {
  it("accepts an exact operator retry without rewriting it, but preserves admin, peer and caller records against changed data", async () => {
    const store = new MemoryCasStore();
    const { ctx } = ctxWith(store);
    const admin = operator("admin-a", "admin");
    const peer = operator("peer-a", "operator", { applications: ["acme"] });
    const caller = operator("caller-a", "operator", {
      applications: ["acme"],
      supersedes: "admin-a",
    });

    for (const record of [admin, peer, caller]) await trustOperator(ctx, record);
    const before = new Map<string, Uint8Array>();
    for (const record of [admin, peer, caller]) {
      before.set(record.id, (await store.getBytes(operatorKey(record.id))) as Uint8Array);
    }

    await expect(trustOperator(ctx, admin)).resolves.toEqual(admin);
    for (const changed of [
      { ...admin, publicKey: key("changed-admin") },
      { ...peer, applications: ["globex"] },
      { ...caller, supersedes: "peer-a" },
    ]) {
      await rejectsWith(() => trustOperator(ctx, changed), "reference-held");
    }

    for (const record of [admin, peer, caller]) {
      expect(await store.getBytes(operatorKey(record.id))).toEqual(before.get(record.id));
    }
  });

  it("gives concurrent operator registrations for one id exactly one owner", async () => {
    const inner = new MemoryCasStore();
    const store = new ReservationBarrierStore(inner, 2);
    const { ctx } = ctxWith(store);

    const settled = await Promise.allSettled([
      trustOperator(ctx, operator(ID, "admin", { publicKey: key("one") })),
      trustOperator(ctx, operator(ID, "admin", { publicKey: key("two") })),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await readJson(ctx, identityKey(ID))).toMatchObject({ value: { kind: "operator" } });
    expect(await readJson(ctx, operatorKey(ID))).not.toBeNull();
  });

  it("atomically chooses one namespace when a node and operator claim the same id", async () => {
    const inner = new MemoryCasStore();
    const store = new ReservationBarrierStore(inner, 2);
    const { ctx } = ctxWith(store);

    const settled = await Promise.allSettled([
      registerNode(ctx, node(ID, "node-key")),
      trustOperator(ctx, operator(ID, "admin", { publicKey: key("operator-key") })),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await readJson<IdentityReservation>(ctx, identityKey(ID))).not.toBeNull();
    expect(
      [await readJson(ctx, nodeKey(ID)), await readJson(ctx, operatorKey(ID))].filter(Boolean),
    ).toHaveLength(1);
  });

  it("completes a crash-shaped reservation only for its matching identity", async () => {
    const store = new MemoryCasStore();
    const { ctx } = ctxWith(store);
    const reserved: IdentityReservation = { v: 1, kind: "node", publicKey: key("node-key") };
    await store.put(identityKey(ID), JSON.stringify(reserved), { ifNoneMatch: "*" });

    await expect(registerNode(ctx, node(ID, "node-key"))).resolves.toMatchObject({ id: ID });
    await rejectsWith(
      () => trustOperator(ctx, operator(ID, "admin", { publicKey: key("node-key") })),
      "reference-held",
    );
    await rejectsWith(() => registerNode(ctx, node(ID, "different")), "reference-held");
  });

  it("adopts a matching legacy operator record without rewriting it", async () => {
    const store = new MemoryCasStore();
    const { ctx } = ctxWith(store);
    const legacy = operator(ID, "admin");
    const bytes = JSON.stringify({ v: 1, id: ID, publicKey: legacy.publicKey });
    await store.put(operatorKey(ID), bytes);

    await expect(trustOperator(ctx, legacy)).resolves.toEqual(legacy);
    expect(await store.getBytes(operatorKey(ID))).toEqual(new TextEncoder().encode(bytes));
    await expect(readJson<IdentityReservation>(ctx, identityKey(ID))).resolves.toMatchObject({
      value: { kind: "operator", publicKey: legacy.publicKey },
    });
  });

  it("keeps tombstones after an operator is revoked", async () => {
    const store = new MemoryCasStore();
    const { ctx } = ctxWith(store);
    await trustOperator(ctx, operator(ID, "admin"));
    await trustOperator(ctx, operator("other-a", "admin"));
    await revokeOperator(ctx, ID);
    await rejectsWith(
      () => trustOperator(ctx, operator(ID, "admin", { publicKey: key("different") })),
      "reference-held",
    );
    await rejectsWith(() => registerNode(ctx, node(ID, "operator-key")), "reference-held");

    /* And a node's own id is reserved the same way, in both directions. */
    const nodeId = "node-tombstone";
    await registerNode(ctx, node(nodeId, "node-key"));
    await rejectsWith(() => registerNode(ctx, node(nodeId, "different")), "reference-held");
    await rejectsWith(
      () => trustOperator(ctx, operator(nodeId, "admin", { publicKey: key("node-key") })),
      "reference-held",
    );

    /* The reservation, not the record, is what refused both: it names the kind
       the id was first claimed as and never changes hands. */
    await expect(readJson<IdentityReservation>(ctx, identityKey(nodeId))).resolves.toMatchObject({
      value: { kind: "node", publicKey: key("node-key") },
    });
    await expect(readJson<IdentityReservation>(ctx, identityKey(ID))).resolves.toMatchObject({
      value: { kind: "operator" },
    });
  });

  it("keeps same-key node restarts mutable", async () => {
    const store = new MemoryCasStore();
    const { ctx } = ctxWith(store);
    await registerNode(ctx, node(ID, "node-key"));
    await registerNode(ctx, {
      ...node(ID, "node-key"),
      addresses: { internal: "10.0.0.2", apiPort: 7401 },
      heartbeatAt: "2026-01-01T00:00:01.000Z",
      drainingAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(readJson<NodeRecord>(ctx, nodeKey(ID))).resolves.toMatchObject({
      value: {
        addresses: { internal: "10.0.0.2", apiPort: 7401 },
        heartbeatAt: "2026-01-01T00:00:01.000Z",
        drainingAt: "2026-01-01T00:00:00.000Z",
      },
    });
  });
});

function operator(
  id: string,
  role: TrustedOperator["role"],
  overrides?: Partial<TrustedOperator>,
): TrustedOperator {
  return { id, publicKey: key(`operator-${id}`), role, ...overrides };
}

function node(id: string, publicKey: string): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: key(publicKey),
    addresses: { internal: "10.0.0.1", apiPort: 7400 },
  };
}

function key(x: string): { kty: "OKP"; crv: "Ed25519"; x: string } {
  return { kty: "OKP", crv: "Ed25519", x };
}

class ReservationBarrierStore implements CasStore {
  readonly #inner: CasStore;
  readonly #waiting: number;
  #arrived = 0;
  #release: (() => void) | undefined;
  readonly #ready: Promise<void>;

  constructor(inner: CasStore, waiting: number) {
    this.#inner = inner;
    this.#waiting = waiting;
    this.#ready = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  get(key: string): Promise<StoredObject | null> {
    return this.#inner.get(key);
  }
  getBytes(key: string, opts?: { range: ByteRange }): Promise<Uint8Array | null> {
    return this.#inner.getBytes(key, opts);
  }
  async put(key: string, body: string | Uint8Array, cas?: CasHeaders): Promise<{ etag: string }> {
    if (key === identityKey(ID) && cas?.ifNoneMatch === "*") {
      this.#arrived++;
      if (this.#arrived === this.#waiting) this.#release?.();
      await this.#ready;
    }
    return this.#inner.put(key, body, cas);
  }
  del(key: string): Promise<void> {
    return this.#inner.del(key);
  }
  list(prefix: string): Promise<string[]> {
    return this.#inner.list(prefix);
  }
  listEntries(prefix: string): Promise<StoredEntry[]> {
    return this.#inner.listEntries(prefix);
  }
}
