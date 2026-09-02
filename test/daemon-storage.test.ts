/* The `/v1/storage` surface: what it refuses, what it stores, and what it does about a lock while it holds one. */

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { H3 } from "h3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type DaemonContext, createNodeApp } from "../src/daemon/app.ts";
import { type DaemonConfig, loadDaemonConfig } from "../src/daemon/config.ts";
import {
  createStorageService,
  STORAGE_TOKEN_BYTES,
  STORAGE_VERSION,
  STORAGE_VERSION_HEADER,
  type StorageService,
} from "../src/daemon/storage.ts";
import { loadStorageTokens } from "../src/cli/_bootstrap.ts";
import {
  loadOrCreateStorageToken,
  STORAGE_TOKEN_FILE,
  writeStorageToken,
} from "../src/cli/_storage-token.ts";
import {
  acquireTlsLock,
  type TlsLock,
  TLS_LOCK_REFRESH_MS,
  TLS_LOCK_STALE_MS,
  tlsLockKey,
} from "../src/core/registry/index.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { fromBase64Url } from "../src/core/utils/base64.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { CLOCK_START_MS, ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const NODE_ID = "node-a";
const VERSION = "0.0.0-test";
const TOKEN = "SdUvvcE1nlEQm4iJ4Nx6BdxUjHZ2Uzt4vPXH0cQnJKk";
const FOREIGN = "someone-else";

/** A set an operator supplied, primary first, as one reads mid-rotation. */
const SUPPLIED: string[] = ["new-token", "old-token", "older-token"];

/** What a configuration needs before it can name anything else. */
const BUCKET_ENV: Record<string, string> = {
  SCAFO_S3_ENDPOINT: "http://store.test:9000",
  SCAFO_S3_BUCKET: "registry",
  SCAFO_S3_ACCESS_KEY: "key",
  SCAFO_S3_SECRET_KEY: "secret",
};

/** Every byte value there is: the payload a text-shaped surface would corrupt. */
const EVERY_BYTE = new Uint8Array(256).map((_, index) => index);

/** Every problem body a rejected caller may see, whatever was wrong with the token. */
const AUTH_INVALID_PROBLEM = {
  type: "urn:scafo:auth-invalid",
  title: "Authentication failed",
  status: 401,
};

/** One call of each route, for the checks that must hold across the whole group. */
const EVERY_ROUTE: Array<[method: string, path: string]> = [
  ["PUT", "/v1/storage/objects/a"],
  ["GET", "/v1/storage/objects/a"],
  ["DELETE", "/v1/storage/objects/a"],
  ["GET", "/v1/storage/list"],
  ["GET", "/v1/storage/stat?key=a"],
  ["POST", "/v1/storage/locks/a"],
  ["DELETE", "/v1/storage/locks/a"],
];

let clock: ManualClock;
let store: MemoryCasStore;
let storage: StorageService;
let logs: string[];
let app: H3;

beforeEach(() => {
  store = new MemoryCasStore();
  clock = ctxWith(store);
  logs = [];

  const agent: DaemonContext = {
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    version: VERSION,
  };
  storage = createStorageService(agent, {
    tokens: [TOKEN],
    log: (message) => logs.push(message),
  });
  agent.storage = storage;
  app = createNodeApp(agent);
});

describe("the token every request must present", () => {
  it("refuses a caller without one, telling it nothing beyond the status", async () => {
    const response = await call("GET", "/v1/storage/list", { token: null });
    const problem = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(problem).toEqual(AUTH_INVALID_PROBLEM);
    /* A detail would separate "no header" from "wrong token" for an attacker. */
    expect(Object.hasOwn(problem, "detail")).toBe(false);
  });

  it("answers every rejected token with a byte-identical problem document", async () => {
    const rejected = [
      "",
      "Bearer",
      /* The same length, one character off: what a guess looks like. */
      `Bearer ${TOKEN.slice(0, -1)}X`,
      /* Longer and shorter than the real one, which must not be told apart. */
      `Bearer ${TOKEN}X`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Basic ${TOKEN}`,
      "Bearer  ",
    ];
    const baseline = await app.request("/v1/storage/list");
    const expected = await baseline.text();

    expect(baseline.status).toBe(401);
    expect(JSON.parse(expected)).toEqual(AUTH_INVALID_PROBLEM);

    for (const authorization of rejected) {
      const response = await app.request("/v1/storage/list", { headers: { authorization } });

      expect(response.status, `for ${JSON.stringify(authorization)}`).toBe(401);
      expect(await response.text(), `for ${JSON.stringify(authorization)}`).toBe(expected);
    }
  });

  it.each(EVERY_ROUTE)("refuses %s %s without one, and stores nothing", async (method, path) => {
    const response = await call(method, path, { token: null, body: EVERY_BYTE });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(AUTH_INVALID_PROBLEM);
    expect(store.size).toBe(0);
  });

  it("serves nothing here at all on a node holding no token", async () => {
    const bare = createNodeApp({
      config: daemonConfig(),
      nodeId: NODE_ID,
      registry: clock.ctx,
      supervisor: fakeSupervisor(),
      version: VERSION,
    });

    /* No route at all, rather than the `401` the same call gets from a node that
       serves the surface: there is nothing here to present a token to. */
    for (const [method, path] of EVERY_ROUTE) {
      const response = await bare.request(path, { method });

      expect(response.status, `for ${method} ${path}`).toBe(404);
      expect((await response.json()) as Record<string, unknown>).not.toMatchObject({
        type: "urn:scafo:auth-invalid",
      });
    }
  });
});

describe("the several tokens an operator may supply instead", () => {
  let admitting: H3;

  beforeEach(() => {
    const agent: DaemonContext = {
      config: daemonConfig(),
      nodeId: NODE_ID,
      registry: clock.ctx,
      supervisor: fakeSupervisor(),
      version: VERSION,
    };
    agent.storage = createStorageService(agent, {
      tokens: SUPPLIED,
      log: (message) => logs.push(message),
    });
    admitting = createNodeApp(agent);
  });

  it.each(SUPPLIED)("admits %s, whichever entry of the set it is", async (token) => {
    const written = await callOn(admitting, "PUT", "/v1/storage/objects/certs/one.crt", token, {
      body: EVERY_BYTE,
    });
    const read = await callOn(admitting, "GET", "/v1/storage/objects/certs/one.crt", token);

    expect(written.status).toBe(204);
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(EVERY_BYTE);
  });

  it("admits every one of them on every route of the group", async () => {
    for (const token of SUPPLIED) {
      for (const [method, path] of EVERY_ROUTE) {
        const response = await callOn(admitting, method, path, token, { body: EVERY_BYTE });

        expect(response.status, `${method} ${path} with "${token}"`).not.toBe(401);
      }
    }
  });

  it("refuses one that is not among them, with the same problem document as ever", async () => {
    const rejected = [TOKEN, `${SUPPLIED[0]}X`, SUPPLIED[0].slice(0, -1), SUPPLIED.join(","), ""];

    for (const token of rejected) {
      const response = await callOn(admitting, "GET", "/v1/storage/list", token);

      expect(response.status, `for "${token}"`).toBe(401);
      await expect(response.json()).resolves.toEqual(AUTH_INVALID_PROBLEM);
    }
  });
});

describe("the protocol version a caller states", () => {
  it("takes a request that states none", async () => {
    await stocked();

    expect((await call("GET", "/v1/storage/list")).status).toBe(200);
  });

  it("takes the version it serves", async () => {
    await stocked();

    const response = await call("GET", "/v1/storage/list", { version: STORAGE_VERSION });

    expect(response.status).toBe(200);
  });

  it("refuses any other, naming the one it serves", async () => {
    const response = await call("GET", "/v1/storage/list", { version: "2" });
    const problem = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(problem.type).toBe("urn:scafo:invalid-input");
    expect(problem.detail).toContain(STORAGE_VERSION);
  });

  it("refuses it on every route of the group", async () => {
    for (const [method, path] of EVERY_ROUTE) {
      const response = await call(method, path, { version: "2", body: EVERY_BYTE });

      expect(response.status, `for ${method} ${path}`).toBe(400);
    }
    expect(store.size).toBe(0);
  });
});

describe("storing a value", () => {
  it("round-trips every byte value, which is what a certificate needs of it", async () => {
    const written = await call("PUT", "/v1/storage/objects/acme/account.key", {
      body: EVERY_BYTE,
    });
    const read = await call("GET", "/v1/storage/objects/acme/account.key");

    expect(written.status).toBe(204);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(EVERY_BYTE);
  });

  it("replaces what was there, last writer winning", async () => {
    await call("PUT", "/v1/storage/objects/a", { body: new Uint8Array([1, 2, 3]) });
    await call("PUT", "/v1/storage/objects/a", { body: new Uint8Array([9]) });

    const read = await call("GET", "/v1/storage/objects/a");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array([9]));
  });

  it("takes an empty value, which is a value like any other", async () => {
    const written = await call("PUT", "/v1/storage/objects/a", { body: new Uint8Array() });
    const read = await call("GET", "/v1/storage/objects/a");

    expect(written.status).toBe(204);
    expect(read.status).toBe(200);
    expect((await read.arrayBuffer()).byteLength).toBe(0);
  });

  it("answers a key nothing was written to as a miss", async () => {
    const response = await call("GET", "/v1/storage/objects/never/written");
    const problem = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(problem.type).toBe("urn:scafo:not-found");
  });
});

describe("deleting a value", () => {
  it("removes the key and everything beneath it", async () => {
    await stocked();

    const response = await call("DELETE", "/v1/storage/objects/certs");

    expect(response.status).toBe(204);
    await expect(listing("", "true")).resolves.toEqual(["acme/account.key", "certsimilar/x"]);
  });

  it("removes a leaf on its own, leaving what shares its start alone", async () => {
    await stocked();

    expect((await call("DELETE", "/v1/storage/objects/certs/a/one.crt")).status).toBe(204);
    await expect(listing("certs", "true")).resolves.toEqual([
      "certs",
      "certs/a/two.crt",
      "certs/b/three.crt",
    ]);
  });

  it("answers a key that named nothing at all as a miss", async () => {
    await stocked();

    expect((await call("DELETE", "/v1/storage/objects/nothing/here")).status).toBe(404);
  });
});

describe("listing what is stored", () => {
  it("answers every key at or under the prefix when asked recursively", async () => {
    await stocked();

    await expect(listing("certs", "true")).resolves.toEqual([
      "certs",
      "certs/a/one.crt",
      "certs/a/two.crt",
      "certs/b/three.crt",
    ]);
  });

  it("folds deeper keys into the child they sit under, once, when not", async () => {
    await stocked();

    await expect(listing("certs")).resolves.toEqual(["certs/a", "certs/b"]);
  });

  it("lists the whole store for an empty prefix, and its top names without one", async () => {
    await stocked();

    await expect(listing("", "true")).resolves.toHaveLength(6);
    await expect(listing("")).resolves.toEqual(["acme", "certs", "certsimilar"]);
  });

  it("answers a prefix nothing matches as a miss, not as an empty list", async () => {
    await stocked();

    for (const recursive of ["true", "false"]) {
      const response = await call(
        "GET",
        `/v1/storage/list?prefix=nothing/here&recursive=${recursive}`,
      );
      const problem = (await response.json()) as Record<string, unknown>;

      expect(response.status, `for recursive=${recursive}`).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(problem.type).toBe("urn:scafo:not-found");
    }
  });

  it("answers an empty store as a miss too, whatever prefix was asked for", async () => {
    for (const query of ["", "?prefix=&recursive=true", "?prefix=certs"]) {
      const response = await call("GET", `/v1/storage/list${query}`);

      expect(response.status, `for ${JSON.stringify(query)}`).toBe(404);
    }
  });

  it("counts a deep key as a match even where it answers the child it sits under", async () => {
    await call("PUT", "/v1/storage/objects/certs/a/deep/one.crt", { body: new Uint8Array([1]) });

    await expect(listing("certs")).resolves.toEqual(["certs/a"]);
  });
});

describe("asking what a key is", () => {
  it("reports a stored value with its size and the time it landed", async () => {
    await stocked();

    const response = await call("GET", "/v1/storage/stat?key=acme/account.key");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      key: "acme/account.key",
      modified: new Date(CLOCK_START_MS).toISOString(),
      size: 3,
      isTerminal: true,
    });
  });

  it("reports a name that only has keys beneath it as no value at all", async () => {
    await stocked();

    const response = await call("GET", "/v1/storage/stat?key=certs/a");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      key: "certs/a",
      modified: null,
      size: 0,
      isTerminal: false,
    });
  });

  it("answers a name that is neither as a miss", async () => {
    await stocked();

    expect((await call("GET", "/v1/storage/stat?key=certs/nowhere")).status).toBe(404);
  });
});

describe("keys the surface refuses", () => {
  const refused = ["", "/absolute", "a//b", "a/", ".", "..", "a/./b", "a/../b", "a b"];

  it.each(refused)("refuses %j wherever a key is named, and stores nothing", async (key) => {
    const encoded = encodeURIComponent(key);

    expect((await call("GET", `/v1/storage/stat?key=${encoded}`)).status).toBe(400);

    const listed = await call("GET", `/v1/storage/list?prefix=${encoded}&recursive=true`);
    /* An empty prefix is the one legal spelling of "everything", so it is turned
       away as a miss over this empty store rather than as a malformed key. */
    expect(listed.status, `listing ${JSON.stringify(key)}`).toBe(key === "" ? 404 : 400);

    expect(store.size).toBe(0);
  });

  it("cannot be walked out of its prefix through the path", async () => {
    /* Dot segments are resolved before a key is ever taken out of the path, so a
       traversal collapses rather than escaping: one that would climb above the
       route names no route at all, and one that stays inside names a key inside. */
    const above = await call("PUT", "/v1/storage/objects/../../escaped", {
      body: new Uint8Array([1]),
    });
    expect(above.status).toBe(404);
    expect(store.size).toBe(0);

    const inside = await call("PUT", "/v1/storage/objects/a/%2e%2e/b", {
      body: new Uint8Array([1]),
    });
    expect(inside.status).toBe(204);
    await expect(listing("", "true")).resolves.toEqual(["b"]);
  });
});

describe("taking a lock", () => {
  it("takes a free one and remembers holding it", async () => {
    const response = await call("POST", "/v1/storage/locks/issue/example.com");

    expect(response.status).toBe(204);
    expect(storage.held()).toEqual(["issue/example.com"]);
    expect((await lockRecord("issue/example.com")).holder).toContain(NODE_ID);
  });

  it("refuses one somebody else keeps fresh", async () => {
    await acquireTlsLock(clock.ctx, "issue", FOREIGN);

    const response = await call("POST", "/v1/storage/locks/issue");
    const problem = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(problem.type).toBe("urn:scafo:cas-conflict");
    expect(storage.held()).toEqual([]);
  });

  it("refuses a second attempt at one it already holds", async () => {
    await call("POST", "/v1/storage/locks/issue");

    expect((await call("POST", "/v1/storage/locks/issue")).status).toBe(409);
  });

  it("takes over one nobody has restamped, and not a moment before", async () => {
    await acquireTlsLock(clock.ctx, "issue", FOREIGN);

    clock.tick(TLS_LOCK_STALE_MS - 1);
    expect((await call("POST", "/v1/storage/locks/issue")).status).toBe(409);

    clock.tick(1);
    expect((await call("POST", "/v1/storage/locks/issue")).status).toBe(204);
    expect(storage.held()).toEqual(["issue"]);
  });
});

describe("keeping a lock", () => {
  it("keeps it out of anyone else's reach for as long as it is restamped", async () => {
    await call("POST", "/v1/storage/locks/issue");

    for (let round = 0; round < 4; round++) {
      clock.tick(TLS_LOCK_REFRESH_MS);
      await storage.refresh();
    }

    /* Twenty seconds on, twice the stale window, and still nobody else's. */
    await rejectsWith(() => acquireTlsLock(clock.ctx, "issue", FOREIGN), "cas-conflict");
    expect(storage.held()).toEqual(["issue"]);
    expect(logs).toEqual([]);
  });

  it("drops one whose restamp did not land, rather than acting as though it had", async () => {
    await call("POST", "/v1/storage/locks/issue");
    clock.tick(TLS_LOCK_STALE_MS);
    const taken = await acquireTlsLock(clock.ctx, "issue", FOREIGN);

    await storage.refresh();

    expect(storage.held()).toEqual([]);
    expect(logs.join("\n")).toContain(`lock "issue" was lost`);
    /* And the record the other holder wrote is untouched by the failed restamp. */
    expect(await lockRecord("issue")).toEqual(taken.lock);
  });

  it("restamps on its own timer, and stops the moment the node does", async () => {
    await call("POST", "/v1/storage/locks/issue");
    const first = await lockRecord("issue");

    vi.useFakeTimers();
    try {
      storage.start();
      clock.tick(TLS_LOCK_REFRESH_MS);
      await vi.advanceTimersByTimeAsync(TLS_LOCK_REFRESH_MS);
      const restamped = await lockRecord("issue");
      expect(restamped.refreshedAt).not.toBe(first.refreshedAt);

      storage.stop();
      clock.tick(TLS_LOCK_REFRESH_MS);
      await vi.advanceTimersByTimeAsync(TLS_LOCK_REFRESH_MS * 3);
      expect((await lockRecord("issue")).refreshedAt).toBe(restamped.refreshedAt);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("giving a lock up", () => {
  it("removes it and frees the name at once", async () => {
    await call("POST", "/v1/storage/locks/issue");

    const response = await call("DELETE", "/v1/storage/locks/issue");

    expect(response.status).toBe(204);
    expect(storage.held()).toEqual([]);
    await expect(store.get(tlsLockKey("issue"))).resolves.toBeNull();
  });

  it("answers a lock this node never took as released all the same", async () => {
    const response = await call("DELETE", "/v1/storage/locks/never-taken");

    expect(response.status).toBe(204);
    expect(logs.join("\n")).toContain(`lock "never-taken" was released without being held here`);
  });

  it("answers a second release as released too", async () => {
    await call("POST", "/v1/storage/locks/issue");
    await call("DELETE", "/v1/storage/locks/issue");

    expect((await call("DELETE", "/v1/storage/locks/issue")).status).toBe(204);
  });

  it("NEVER removes a lock somebody else holds, and says so as it declines to", async () => {
    await call("POST", "/v1/storage/locks/issue");
    clock.tick(TLS_LOCK_STALE_MS);
    const taken = await acquireTlsLock(clock.ctx, "issue", FOREIGN);

    const response = await call("DELETE", "/v1/storage/locks/issue");

    expect(response.status).toBe(204);
    expect(await lockRecord("issue")).toEqual(taken.lock);
    expect(logs.join("\n")).toContain(`lock "issue" had already been taken over`);
  });

  it("NEVER removes a fresh lock this node never held", async () => {
    const taken = await acquireTlsLock(clock.ctx, "issue", FOREIGN);

    expect((await call("DELETE", "/v1/storage/locks/issue")).status).toBe(204);
    expect(await lockRecord("issue")).toEqual(taken.lock);
  });
});

describe("the token file guarding the surface", () => {
  it("writes a fresh token only its owner can read, in a directory only its owner can enter", async () => {
    const dir = await stateDir();

    const token = await loadOrCreateStorageToken(dir);

    expect(fromBase64Url(token)).toHaveLength(STORAGE_TOKEN_BYTES);
    /* Unpadded base64url: nothing in it needs escaping in a header or a file. */
    expect(token).toMatch(/^[\w-]+$/);
    expect((await stat(join(dir, STORAGE_TOKEN_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("keeps the token it wrote, so a restarted node stays reachable", async () => {
    const dir = await stateDir();

    expect(await loadOrCreateStorageToken(dir)).toBe(await loadOrCreateStorageToken(dir));
  });

  it("takes a token an operator wrote, newline and all", async () => {
    const dir = await stateDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, STORAGE_TOKEN_FILE), "  chosen-token\n");

    expect(await loadOrCreateStorageToken(dir)).toBe("chosen-token");
  });

  it("refuses a file holding no token rather than guarding the surface with nothing", async () => {
    const dir = await stateDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, STORAGE_TOKEN_FILE), "\n  \n");

    await rejectsWith(() => loadOrCreateStorageToken(dir), "invalid-input");
  });
});

describe("the token set a node boots with", () => {
  it("mints its own when the operator supplied none, and keeps it across boots", async () => {
    const dir = await stateDir();

    const first = await loadStorageTokens(await bootConfig(dir));
    const again = await loadStorageTokens(await bootConfig(dir));

    expect(first).toHaveLength(1);
    expect(fromBase64Url(first[0])).toHaveLength(STORAGE_TOKEN_BYTES);
    expect(again).toEqual(first);
    await expect(readFile(join(dir, STORAGE_TOKEN_FILE), "utf8")).resolves.toBe(`${first[0]}\n`);
  });

  it("writes the primary an operator supplied where every file-reading consumer looks", async () => {
    const dir = await stateDir();

    const tokens = await loadStorageTokens(await bootConfig(dir, " chosen-token "));

    /* Supplied REPLACES minting: nothing random is generated, and the file holds
       what the operator chose, at the permissions a minted one gets. */
    expect(tokens).toEqual(["chosen-token"]);
    await expect(readFile(join(dir, STORAGE_TOKEN_FILE), "utf8")).resolves.toBe("chosen-token\n");
    expect((await stat(join(dir, STORAGE_TOKEN_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("takes over a token this node had minted, primary first", async () => {
    const dir = await stateDir();
    const minted = await loadStorageTokens(await bootConfig(dir));

    const tokens = await loadStorageTokens(await bootConfig(dir, "new-token, old-token"));

    expect(minted[0]).not.toBe("new-token");
    expect(tokens).toEqual(["new-token", "old-token"]);
    await expect(readFile(join(dir, STORAGE_TOKEN_FILE), "utf8")).resolves.toBe("new-token\n");
  });

  it("leaves the file untouched on a boot the primary did not change", async () => {
    const dir = await stateDir();
    const path = join(dir, STORAGE_TOKEN_FILE);
    await writeStorageToken(dir, "chosen-token");

    /* Dated back rather than compared to "now", so nothing here rests on the
       clock's resolution. */
    const past = new Date(CLOCK_START_MS);
    await utimes(path, past, past);
    await writeStorageToken(dir, "chosen-token");

    expect((await stat(path)).mtimeMs).toBe(past.getTime());

    await writeStorageToken(dir, "rotated-token");

    expect((await stat(path)).mtimeMs).not.toBe(past.getTime());
    await expect(readFile(path, "utf8")).resolves.toBe("rotated-token\n");
  });
});

describe("rotating a supplied token, as an operator expands and contracts the set", () => {
  it("takes both while the set holds both, and only the new one once it does not", async () => {
    const dir = await stateDir();
    const path = join(dir, STORAGE_TOKEN_FILE);

    /* Before: one token, and it is the file's. */
    const before = await boot(dir, "old-token");
    expect((await stored(before, "old-token")).status).toBe(204);
    expect((await stored(before, "new-token")).status).toBe(401);
    await expect(readFile(path, "utf8")).resolves.toBe("old-token\n");

    /* Expanded: the operator restarts the agent with both, and the file follows
       the primary — which is what an ingress reloaded now picks up. */
    const expanded = await boot(dir, "new-token,old-token");
    expect((await stored(expanded, "new-token")).status).toBe(204);
    expect((await stored(expanded, "old-token")).status).toBe(204);
    await expect(readFile(path, "utf8")).resolves.toBe("new-token\n");

    /* Contracted: the old one is refused from this boot on. */
    const contracted = await boot(dir, "new-token");
    expect((await stored(contracted, "new-token")).status).toBe(204);
    expect((await stored(contracted, "old-token")).status).toBe(401);
    await expect(readFile(path, "utf8")).resolves.toBe("new-token\n");
  });
});

interface CallOptions {
  /** Bearer token to present; null presents none, and undefined presents the right one. */
  token?: string | null;
  /** Value of the version header; absent states none. */
  version?: string;
  body?: BodyInit;
}

/** One call to the storage surface, authenticated unless the test says otherwise. */
async function call(method: string, path: string, opts?: CallOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = opts?.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (opts?.version !== undefined) headers[STORAGE_VERSION_HEADER] = opts.version;

  const sendsBody = method === "PUT" || method === "POST";
  return app.request(path, {
    method,
    headers,
    ...(sendsBody && opts?.body !== undefined ? { body: opts.body } : {}),
  });
}

/** One call to an app a boot built rather than to the suite's own. */
async function callOn(
  target: H3,
  method: string,
  path: string,
  token: string,
  opts?: { body?: BodyInit },
): Promise<Response> {
  const sendsBody = method === "PUT" || method === "POST";
  return target.request(path, {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(sendsBody && opts?.body !== undefined ? { body: opts.body } : {}),
  });
}

/** One write through a booted node, which is the whole of what a token buys. */
async function stored(target: H3, token: string): Promise<Response> {
  return callOn(target, "PUT", "/v1/storage/objects/rotation", token, {
    body: new Uint8Array([1]),
  });
}

/** The configuration a node boots from, as an operator's environment carries it. */
async function bootConfig(dir: string, token?: string): Promise<DaemonConfig> {
  return loadDaemonConfig({
    env: {
      ...BUCKET_ENV,
      SCAFO_STATE_DIR: dir,
      ...(token === undefined ? {} : { SCAFO_STORAGE_TOKEN: token }),
    },
  });
}

/** One boot of a node, serving whatever token set its configuration resolved to. */
async function boot(dir: string, token?: string): Promise<H3> {
  const config = await bootConfig(dir, token);
  const agent: DaemonContext = {
    config,
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    version: VERSION,
  };
  agent.storage = createStorageService(agent, {
    tokens: await loadStorageTokens(config),
    log: (message) => logs.push(message),
  });
  return createNodeApp(agent);
}

/** The keys the list route answers for one prefix. */
async function listing(prefix: string, recursive?: string): Promise<string[]> {
  const query = new URLSearchParams({ prefix, ...(recursive === undefined ? {} : { recursive }) });
  const response = await call("GET", `/v1/storage/list?${query.toString()}`);

  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as string[];
}

/** The lock record as it stands in the bucket. */
async function lockRecord(name: string): Promise<TlsLock> {
  const object = await store.get(tlsLockKey(name));
  expect(object, `no lock record at "${name}"`).not.toBeNull();
  return JSON.parse(object?.body ?? "") as TlsLock;
}

/** A store holding a value at a prefix, under it, and beside a name sharing its start. */
async function stocked(): Promise<void> {
  const keys = [
    "acme/account.key",
    "certs",
    "certs/a/one.crt",
    "certs/a/two.crt",
    "certs/b/three.crt",
    "certsimilar/x",
  ];
  for (const key of keys) {
    const response = await call("PUT", `/v1/storage/objects/${key}`, {
      body: new Uint8Array(key === "certs" ? 1 : 3),
    });
    expect(response.status, `while stocking "${key}"`).toBe(204);
  }
}

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A state directory of this run's own; nothing here touches the machine's. */
async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scafo-storage-"));
  roots.push(root);
  return join(root, "state");
}

function daemonConfig(): DaemonConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: NODE_ID, listen: "127.0.0.1:7400" },
    platformDomains: ["apps.test"],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      bindHost: "127.0.0.1",
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
  };
}

/** Reports nothing; no route under test asks it anything. */
function fakeSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: (): ProcessStatus[] => [],
    onExit: () => {},
  };
}
