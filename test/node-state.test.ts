/*
 * The identity a node keeps between boots: what is written on the first one, what is read back on
 * the next, and what happens to a state file that no longer says who this node is.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createNodeVerifier, signNodeToken } from "../src/core/auth/node-token.ts";
import { registerNode } from "../src/core/registry/nodes.ts";
import { loadOrCreateNodeState, NODE_STATE_FILE, type NodeState } from "../src/cli/_node-state.ts";
import { resolveDefaultStateDir, SYSTEM_STATE_DIR } from "../src/cli/_utils.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, rejectsWith } from "./_helpers.ts";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("the first boot of a node", () => {
  it("writes an identity only its owner can read, in a directory only its owner can enter", async () => {
    const dir = await stateDir();

    const state = await loadOrCreateNodeState(dir);

    const file = await stat(join(dir, NODE_STATE_FILE));
    expect(file.mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(state.id).toMatch(/^node-[0-9a-f]{8}$/);
  });

  it("generates an Ed25519 pair, both halves of it, and persists exactly what it returns", async () => {
    const dir = await stateDir();

    const state = await loadOrCreateNodeState(dir);

    expect(state.privateKey).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    expect(state.publicKey).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    expect(typeof state.privateKey.d).toBe("string");
    expect(state.publicKey.x).toBe(state.privateKey.x);
    expect((await stored(dir)).privateKey.d).toBe(state.privateKey.d);
  });

  it("registers under the id the configuration pins, when it pins one", async () => {
    const dir = await stateDir();

    const state = await loadOrCreateNodeState(dir, { id: "node_west-1" });

    expect(state.id).toBe("node_west-1");
    expect((await stored(dir)).id).toBe("node_west-1");
  });

  it("refuses an id that could not address a registry record, writing nothing", async () => {
    const dir = await stateDir();

    const error = await rejectsWith(
      () => loadOrCreateNodeState(dir, { id: "NODE 1" }),
      "invalid-slug",
    );

    expect(error.detail).toContain("NODE 1");
    await expect(stat(join(dir, NODE_STATE_FILE))).rejects.toThrow(/ENOENT/);
  });

  it("keeps a key the installation's own verifier accepts", async () => {
    const dir = await stateDir();
    const state = await loadOrCreateNodeState(dir, { id: "node-signer" });
    const { ctx } = ctxWith(new MemoryCasStore());
    await registerNode(ctx, {
      v: 1,
      id: state.id,
      publicKey: { kty: "OKP", crv: "Ed25519", x: state.publicKey.x },
      addresses: { internal: "10.0.0.4", apiPort: 7400 },
    });

    const token = await signNodeToken(state.privateKey, state.id);
    const identity = await createNodeVerifier(ctx).verify(token);

    expect(identity.nodeId).toBe(state.id);
  });
});

describe("every boot after the first", () => {
  it("reads back the same id and the same keys", async () => {
    const dir = await stateDir();
    const first = await loadOrCreateNodeState(dir);

    const second = await loadOrCreateNodeState(dir);

    expect(second).toEqual(first);
  });

  it("leaves the identity alone when the configuration pins the id it already has", async () => {
    const dir = await stateDir();
    const first = await loadOrCreateNodeState(dir, { id: "node-steady" });

    const second = await loadOrCreateNodeState(dir, { id: "node-steady" });

    expect(second).toEqual(first);
  });

  it("replaces the identity when the configuration pins a different id, and says so", async () => {
    const dir = await stateDir();
    const first = await loadOrCreateNodeState(dir, { id: "node-old" });
    const said: string[] = [];

    const second = await loadOrCreateNodeState(dir, { id: "node-new", log: (m) => said.push(m) });

    expect(second.id).toBe("node-new");
    expect(second.privateKey.d).not.toBe(first.privateKey.d);
    expect(await stored(dir)).toEqual(second);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("node-old");
    expect(said[0]).toContain("node-new");
  });
});

describe("a state file that no longer says who this node is", () => {
  it("refuses to boot on unparseable contents rather than generating a new identity", async () => {
    const dir = await stateDir();
    await write(dir, "{ not json");

    const error = await rejectsWith(() => loadOrCreateNodeState(dir), "invalid-input");

    expect(error.detail).toContain(NODE_STATE_FILE);
    expect(error.detail).toContain("delete the file");
    expect(await read(dir)).toBe("{ not json");
  });

  it("refuses every shape that is not an identity, naming what is wrong with it", async () => {
    const cases: [string, string][] = [
      ["[]", "JSON object"],
      [JSON.stringify({ privateKey: {}, publicKey: {} }), `"id"`],
      [JSON.stringify({ id: "node-a", publicKey: {} }), `"privateKey"`],
      [
        JSON.stringify({
          id: "node-a",
          privateKey: { kty: "OKP", crv: "Ed25519", x: "x", d: "d" },
          publicKey: { kty: "EC", crv: "P-256", x: "x" },
        }),
        `"publicKey"`,
      ],
      [
        JSON.stringify({
          id: "node-a",
          privateKey: { kty: "OKP", crv: "Ed25519", x: "x" },
          publicKey: { kty: "OKP", crv: "Ed25519", x: "x" },
        }),
        `"d"`,
      ],
    ];

    for (const [contents, expected] of cases) {
      const dir = await stateDir();
      await write(dir, contents);

      const error = await rejectsWith(() => loadOrCreateNodeState(dir), "invalid-input");
      expect(error.detail, contents).toContain(expected);
    }
  });

  it("refuses an id the registry could not address, even from a file it wrote itself", async () => {
    const dir = await stateDir();
    const state = await loadOrCreateNodeState(dir);
    await write(dir, JSON.stringify({ ...state, id: "NODE 1" }));

    const error = await rejectsWith(() => loadOrCreateNodeState(dir), "invalid-slug");

    expect(error.detail).toContain("NODE 1");
  });
});

describe("where the state lives when nothing configures it", () => {
  it("resolves an absolute path outside whatever directory the node was started in", async () => {
    const resolved = resolveDefaultStateDir({ XDG_STATE_HOME: "relative/state" });

    expect(resolved.startsWith("/")).toBe(true);
    expect(resolved.startsWith(process.cwd())).toBe(false);
    expect(resolved).toMatch(/scafo$/);
  });

  it("prefers XDG_STATE_HOME when it is absolute, and the system directory for root", async () => {
    const xdg = resolveDefaultStateDir({ XDG_STATE_HOME: "/xdg/state" });

    expect(xdg).toBe(process.getuid?.() === 0 ? SYSTEM_STATE_DIR : "/xdg/state/scafo");
    expect(resolveDefaultStateDir({})).toMatch(
      process.getuid?.() === 0 ? /^\/var\/lib\/scafo$/ : /\.local\/state\/scafo$/,
    );
  });
});

/** A directory that does not exist yet, inside a temporary root of this run's own. */
async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scafo-node-state-"));
  roots.push(root);
  return join(root, "state");
}

async function stored(dir: string): Promise<NodeState> {
  return JSON.parse(await read(dir)) as NodeState;
}

function read(dir: string): Promise<string> {
  return readFile(join(dir, NODE_STATE_FILE), "utf8");
}

/** Puts `contents` where the node keeps its identity, creating the directory. */
async function write(dir: string, contents: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, NODE_STATE_FILE), contents, "utf8");
}
