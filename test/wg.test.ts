/*
 * The assisted WireGuard setup: where a node's tunnel keys come from, what its
 * `wg0.conf` says, what it publishes about itself in the registry, and what a
 * node whose transport is a tunnel refuses to boot without.
 *
 * scafo never computes an X25519 key, so neither does this suite: the keypair
 * comes out of a state directory, or out of a `wg` that is a shell script on a
 * temporary PATH. No interface is ever brought up — that needs a kernel module
 * and NET_ADMIN, and is the operator's step by design.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { type DaemonConfig, loadDaemonConfig } from "../src/daemon/config.ts";
import { loadWireguardRecord, publishWireguard, registerThisNode } from "../src/cli/_bootstrap.ts";
import type { NodeState } from "../src/cli/_node-state.ts";
import { collectWireguardPeers, renderWireguardConf } from "../src/cli/_wg-conf.ts";
import {
  ensureWireguardKeys,
  isWireguardKey,
  readWireguardKeys,
  resolveWireguardSettings,
  WG_PRIVATE_KEY_FILE,
  WG_PUBLIC_KEY_FILE,
} from "../src/cli/_wireguard.ts";
import { getNode, registerNode } from "../src/core/registry/nodes.ts";
import { nodeKey } from "../src/core/registry/paths.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, rejectsWith } from "./_helpers.ts";

/** Bucket settings every configuration in this suite needs and none of it uses. */
const REQUIRED_ENV: Record<string, string> = {
  SCAFO_S3_ENDPOINT: "http://store.test:9000",
  SCAFO_S3_BUCKET: "registry",
  SCAFO_S3_ACCESS_KEY: "key",
  SCAFO_S3_SECRET_KEY: "secret",
};

/** What the fake `wg` on PATH prints, so every assertion knows the answer. */
const SHIM_PRIVATE = wgKey(0x11);
const SHIM_PUBLIC = wgKey(0x22);
/** A key that was already in the state directory before anything ran. */
const STORED_PRIVATE = wgKey(0x33);
const STORED_PUBLIC = wgKey(0x44);

const NODE_A = "node-a";
const NODE_B = "node-b";
const NODE_C = "node-c";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("where a node's tunnel keys come from", () => {
  it("reads the pair the operator already put in the state directory, running nothing", async () => {
    const dir = await stateDir();
    await writeKeys(dir, STORED_PRIVATE, STORED_PUBLIC);
    /* Nothing on PATH at all: a node whose keys are on disk must never need the
       tool that made them, so `scafo sail` works on a host without it. */
    await usePath(await emptyDir());

    const keys = await ensureWireguardKeys(dir);

    expect(keys).toEqual({
      privateKey: STORED_PRIVATE,
      publicKey: STORED_PUBLIC,
      from: { privateKey: "state", publicKey: "state" },
    });
  });

  it("makes one with the operator's own `wg` when there is none, and keeps it", async () => {
    const dir = await stateDir();
    await useShim();

    const keys = await ensureWireguardKeys(dir);

    expect(keys).toEqual({
      privateKey: SHIM_PRIVATE,
      publicKey: SHIM_PUBLIC,
      from: { privateKey: "wg", publicKey: "wg" },
    });
    /* Persisted, so the second call is the read above rather than a new key the
       peers have never been told about. */
    expect(await readFile(join(dir, WG_PRIVATE_KEY_FILE), "utf8")).toBe(`${SHIM_PRIVATE}\n`);
    expect(await readFile(join(dir, WG_PUBLIC_KEY_FILE), "utf8")).toBe(`${SHIM_PUBLIC}\n`);
  });

  it("derives only the public half when the private one was supplied by hand", async () => {
    /* The documented path: an operator runs `wg genkey > wg-private.key`, and
       scafo works out the rest without ever choosing key material itself. */
    const dir = await stateDir();
    await writeFile(join(dir, WG_PRIVATE_KEY_FILE), `${STORED_PRIVATE}\n`);
    await useShim();

    const keys = await ensureWireguardKeys(dir);

    expect(keys).toEqual({
      privateKey: STORED_PRIVATE,
      publicKey: SHIM_PUBLIC,
      from: { privateKey: "state", publicKey: "wg" },
    });
  });

  it("writes both halves readable by their owner alone, in a directory only they can enter", async () => {
    const dir = await stateDir();
    await useShim();

    await ensureWireguardKeys(dir);

    expect((await stat(join(dir, WG_PRIVATE_KEY_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, WG_PUBLIC_KEY_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("refuses, rather than inventing a key, when there is neither a file nor a `wg`", async () => {
    const dir = await stateDir();
    await usePath(await emptyDir());

    const error = await rejectsWith(() => ensureWireguardKeys(dir), "invalid-input");

    /* Actionable on its own: the exact command, the exact path, the mode. */
    expect(error.detail).toContain(`wg genkey > ${join(dir, WG_PRIVATE_KEY_FILE)}`);
    expect(error.detail).toContain("chmod 600");
    expect(error.detail).toContain("scafo never derives an X25519 key");
  });

  it("refuses when it holds a private key it cannot derive the public half of", async () => {
    const dir = await stateDir();
    await writeFile(join(dir, WG_PRIVATE_KEY_FILE), `${STORED_PRIVATE}\n`);
    await usePath(await emptyDir());

    const error = await rejectsWith(() => ensureWireguardKeys(dir), "invalid-input");

    expect(error.detail).toContain("wg pubkey <");
    expect(error.detail).toContain(WG_PUBLIC_KEY_FILE);
  });

  it("refuses a key file that does not hold a key rather than replacing it", async () => {
    for (const contents of ["", "not a key", `${STORED_PRIVATE.slice(0, 20)}=`, "hunter2"]) {
      const dir = await stateDir();
      await writeFile(join(dir, WG_PRIVATE_KEY_FILE), contents);
      await useShim();

      const error = await rejectsWith(() => ensureWireguardKeys(dir), "invalid-input");
      expect(error.detail, contents).toContain("44 base64 characters");
      /* Left exactly as it was: replacing it would strand every peer that had
         already been told the key it named. */
      expect(await readFile(join(dir, WG_PRIVATE_KEY_FILE), "utf8"), contents).toBe(contents);
    }
  });

  it("refuses two key files that are not halves of one pair", async () => {
    /*
     * The quiet, expensive failure: an operator re-runs `wg genkey` and leaves
     * the old public key behind. Every file looks correct, the node publishes a
     * key no peer's handshake can complete against, and nothing says so.
     */
    const dir = await stateDir();
    await writeKeys(dir, SHIM_PRIVATE, STORED_PUBLIC);
    await useShim();

    const error = await rejectsWith(() => ensureWireguardKeys(dir), "invalid-input");

    expect(error.detail).toContain(WG_PUBLIC_KEY_FILE);
    expect(error.detail).toContain("never complete a handshake");
    expect(error.detail).toContain(SHIM_PUBLIC);
  });

  it("accepts a pair that is one, and keeps its word on a host with no `wg`", async () => {
    const matching = await stateDir();
    await writeKeys(matching, SHIM_PRIVATE, SHIM_PUBLIC);
    await useShim();
    await expect(ensureWireguardKeys(matching)).resolves.toMatchObject({
      publicKey: SHIM_PUBLIC,
    });

    /* Without `wg` nothing can tell the two apart, and a host that was given a
       pair keeps it rather than being refused for what cannot be checked. */
    const unchecked = await stateDir();
    await writeKeys(unchecked, SHIM_PRIVATE, STORED_PUBLIC);
    await usePath(await emptyDir());
    await expect(ensureWireguardKeys(unchecked)).resolves.toMatchObject({
      publicKey: STORED_PUBLIC,
    });
  });

  it("takes a key however the tool spelled it, and nothing that is not one", () => {
    expect(isWireguardKey(SHIM_PRIVATE)).toBe(true);
    expect(isWireguardKey(wgKey(0xff))).toBe(true);

    for (const value of ["", "AAAA", `${SHIM_PRIVATE}extra`, SHIM_PRIVATE.replace("=", "A")]) {
      expect(isWireguardKey(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("what `scafo sail` reads back, and what it will not do", () => {
  it("reads a complete pair without touching PATH", async () => {
    const dir = await stateDir();
    await writeKeys(dir, STORED_PRIVATE, STORED_PUBLIC);

    await expect(readWireguardKeys(dir)).resolves.toEqual({
      privateKey: STORED_PRIVATE,
      publicKey: STORED_PUBLIC,
      from: { privateKey: "state", publicKey: "state" },
    });
  });

  it("reports no keys at all rather than half a pair", async () => {
    const empty = await stateDir();
    const halfway = await stateDir();
    await writeFile(join(halfway, WG_PRIVATE_KEY_FILE), `${STORED_PRIVATE}\n`);

    expect(await readWireguardKeys(empty)).toBeNull();
    expect(await readWireguardKeys(halfway)).toBeNull();
  });

  it("refuses to boot a node whose transport is a tunnel it has not been set up on", async () => {
    const dir = await stateDir();
    const config = await tunnelConfig({ SCAFO_STATE_DIR: dir });

    const error = await rejectsWith(() => loadWireguardRecord(config), "invalid-input");

    expect(error.detail).toContain("scafo wg init");
    expect(error.detail).toContain(dir);
  });

  it("publishes the key, endpoint and address once it has been", async () => {
    const dir = await stateDir();
    await writeKeys(dir, STORED_PRIVATE, STORED_PUBLIC);
    const config = await tunnelConfig({ SCAFO_STATE_DIR: dir });

    await expect(loadWireguardRecord(config)).resolves.toEqual({
      publicKey: STORED_PUBLIC,
      endpoint: "203.0.113.7:51820",
      address: "10.83.0.1/24",
    });
  });

  it("leaves a node on another transport alone, and says the settings are ignored", async () => {
    const said: string[] = [];
    const config = await loadDaemonConfig({
      env: {
        ...REQUIRED_ENV,
        SCAFO_TRANSPORT: "none",
        SCAFO_WG_ADDRESS: "10.83.0.1/24",
        SCAFO_WG_ENDPOINT: "203.0.113.7:51820",
      },
    });

    await expect(
      loadWireguardRecord(config, { warn: (m) => said.push(m) }),
    ).resolves.toBeUndefined();

    /* Refusal-over-silence, in its mildest form: nothing reads these, and an
       operator who wrote them meant something by it. */
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("ignored");
    expect(said[0]).toContain("--transport wireguard");
  });

  it("names the setting a tunnel node is missing, and what it is for", async () => {
    const cases: [string, Record<string, string>, string][] = [
      ["no address", { SCAFO_WG_ENDPOINT: "203.0.113.7:51820" }, "wireguard.address"],
      ["no endpoint", { SCAFO_WG_ADDRESS: "10.83.0.1/24" }, "wireguard.endpoint"],
      ["neither", {}, "wireguard.address"],
    ];

    for (const [what, env, expected] of cases) {
      const config = await loadDaemonConfig({
        env: { ...REQUIRED_ENV, SCAFO_TRANSPORT: "wireguard", ...env },
      });

      const error = await rejectsWith(
        () => Promise.resolve(resolveWireguardSettings(config)),
        "invalid-input",
      );
      expect(error.detail, what).toContain(expected);
      /* Every way it can be given, so the message needs no documentation. */
      expect(error.detail, what).toContain("SCAFO_WG_");
      expect(error.detail, what).toContain("--wg-");
    }
  });

  it("refuses an address that names no subnet and an endpoint that names no port", async () => {
    const address = await rejectsWith(
      () =>
        loadDaemonConfig({
          env: { ...REQUIRED_ENV, SCAFO_TRANSPORT: "wireguard", SCAFO_WG_ADDRESS: "10.83.0.1" },
        }),
      "invalid-input",
    );
    expect(address.detail).toContain("10.83.0.1/24");

    const endpoint = await rejectsWith(
      () =>
        loadDaemonConfig({
          env: {
            ...REQUIRED_ENV,
            SCAFO_TRANSPORT: "wireguard",
            SCAFO_WG_ADDRESS: "10.83.0.1/24",
            SCAFO_WG_ENDPOINT: "203.0.113.7",
          },
        }),
      "invalid-input",
    );
    expect(endpoint.detail).toContain("wireguard.endpoint");
  });
});

describe("the addresses a tunnelled node uses", () => {
  it("binds its runtime processes to the tunnel and advertises itself there", async () => {
    /*
     * Inside a tunnel the only address that means anything is the tunnel's:
     * loopback is unreachable from the other nodes, and the wildcard the daemon
     * listener binds names no interface a peer could dial.
     */
    const config = await tunnelConfig({ SCAFO_LISTEN: "0.0.0.0:7400" });

    expect(config.runtime.bindHost).toBe("10.83.0.1");
    expect(config.node.advertise).toBe("10.83.0.1:7400");
  });

  it("puts the daemon listener on the tunnel too, so what it advertises is bound", async () => {
    /* The three move together or not at all: a node advertising an address its
       listener never bound refuses every peer that dials it and says nothing. */
    const config = await tunnelConfig();

    expect(config.node.listen).toBe("10.83.0.1:7400");
    expect(config.node.advertise).toBe("10.83.0.1:7400");
    expect(config.runtime.bindHost).toBe("10.83.0.1");
  });

  it("refuses a tunnel address that is a wildcard or covers everything", async () => {
    /* Neither is an address an interface could hold, and a node registering one
       as what peers should dial is exactly what the tunnel default prevents. */
    for (const address of ["0.0.0.0/0", "0.0.0.0/24", "::/0", "10.83.0.1/0"]) {
      const error = await rejectsWith(
        () =>
          loadDaemonConfig({
            env: { ...REQUIRED_ENV, SCAFO_TRANSPORT: "wireguard", SCAFO_WG_ADDRESS: address },
          }),
        "invalid-input",
      );
      expect(error.detail, address).toContain("wireguard.address");
    }
  });

  it("takes the port from the internal listener when there is one", async () => {
    const config = await tunnelConfig({
      SCAFO_LISTEN: "0.0.0.0:7400",
      SCAFO_INTERNAL_LISTEN: "0.0.0.0:7401",
    });

    expect(config.node.advertise).toBe("10.83.0.1:7401");
  });

  it("still lets the operator say otherwise, on either", async () => {
    const config = await tunnelConfig({
      SCAFO_LISTEN: "0.0.0.0:7400",
      SCAFO_BIND_HOST: "0.0.0.0",
      SCAFO_ADVERTISE: "node-a.internal:7400",
    });

    expect(config.runtime.bindHost).toBe("0.0.0.0");
    expect(config.node.advertise).toBe("node-a.internal:7400");
  });

  it("changes nothing for a node that runs no tunnel", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_TRANSPORT: "none", SCAFO_LISTEN: "0.0.0.0:7400" },
    });

    expect(config.runtime.bindHost).toBe("127.0.0.1");
    expect(config.node.advertise).toBeUndefined();
  });
});

describe("what a node publishes about its place on the tunnel", () => {
  it("writes the wireguard field into its own record, alongside everything else", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());
    const config = await tunnelConfig({ SCAFO_LISTEN: "0.0.0.0:7400" });

    const record = await registerThisNode(ctx, {
      config,
      state: nodeState(NODE_A),
      wireguard: {
        publicKey: STORED_PUBLIC,
        endpoint: "203.0.113.7:51820",
        address: "10.83.0.1/24",
      },
    });

    expect(record.wireguard).toEqual({
      publicKey: STORED_PUBLIC,
      endpoint: "203.0.113.7:51820",
      address: "10.83.0.1/24",
    });
    /* The advertised address follows the tunnel too, so a peer dials the node
       inside it rather than on whatever the listener happened to bind. */
    expect(record.addresses).toEqual({ internal: "10.83.0.1", apiPort: 7400 });
    expect((await getNode(ctx, NODE_A)).wireguard?.publicKey).toBe(STORED_PUBLIC);
  });

  it("leaves the field off a node that runs no tunnel, so the record stays additive", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    const record = await registerThisNode(ctx, { config, state: nodeState(NODE_A) });

    expect("wireguard" in record).toBe(false);
  });

  it("changes nothing but the tunnel field of a record the daemon already wrote", async () => {
    /*
     * `scafo wg init` is run from an operator's shell, not from the daemon's
     * environment, so the configuration it resolves may not be the one the node
     * is running on. Rewriting the record from it would move the node's
     * advertised address along with its tunnel details, and nothing
     * would report it until a peer failed to reach it.
     */
    const { ctx } = ctxWith(new MemoryCasStore());
    const running = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_TRANSPORT: "none", SCAFO_ADVERTISE: "10.0.0.4:9000" },
    });
    const before = await registerThisNode(ctx, {
      config: running,
      state: nodeState(NODE_A),
    });

    /* A different shell entirely: no advertise, so the defaults would apply. */
    const elsewhere = await loadDaemonConfig({ env: REQUIRED_ENV });
    const after = await publishWireguard(ctx, {
      config: elsewhere,
      state: nodeState(NODE_A),
      wireguard: {
        publicKey: STORED_PUBLIC,
        endpoint: "203.0.113.7:51820",
        address: "10.83.0.1/24",
      },
    });

    expect(after.addresses).toEqual(before.addresses);
    expect(after.wireguard?.publicKey).toBe(STORED_PUBLIC);
  });

  it("merges WireGuard onto a sail registration that wins its read-null race", async () => {
    const store = new FaultStore(new MemoryCasStore());
    const { ctx } = ctxWith(store);
    const running = await loadDaemonConfig({
      env: {
        ...REQUIRED_ENV,
        SCAFO_TRANSPORT: "none",
        SCAFO_ADVERTISE: "10.0.0.4:9000",
        SCAFO_NODE_LABELS: "tier=fast,region=eu-west-1",
      },
    });
    const sailOptions = {
      config: running,
      state: nodeState(NODE_A),
    } satisfies Parameters<typeof registerThisNode>[1];
    let sailed: NodeRecord | null = null;
    store.onBeforePut = async (key): Promise<void> => {
      if (key !== nodeKey(NODE_A)) return;
      store.onBeforePut = undefined;
      sailed = await registerThisNode(ctx, sailOptions);
    };

    const elsewhere = await loadDaemonConfig({ env: REQUIRED_ENV });
    const after = await publishWireguard(ctx, {
      config: elsewhere,
      state: nodeState(NODE_A),
      wireguard: {
        publicKey: STORED_PUBLIC,
        endpoint: "203.0.113.7:51820",
        address: "10.83.0.1/24",
      },
    });

    expect(sailed).not.toBeNull();
    const { wireguard, ...withoutWireguard } = after;
    expect(withoutWireguard).toEqual(sailed);
    expect(wireguard).toEqual({
      publicKey: STORED_PUBLIC,
      endpoint: "203.0.113.7:51820",
      address: "10.83.0.1/24",
    });
    expect(after.addresses).toEqual({ internal: "10.0.0.4", apiPort: 9000 });
    expect(after.labels).toEqual({ tier: "fast", region: "eu-west-1" });
  });

  it("registers a node outright when it has no record yet", async () => {
    /* `scafo wg init` before the first `scafo sail` is the order the setup
       instructions ask for, so there is nothing to narrow an update to. */
    const { ctx } = ctxWith(new MemoryCasStore());
    const config = await tunnelConfig();

    const record = await publishWireguard(ctx, {
      config,
      state: nodeState(NODE_A),
      wireguard: {
        publicKey: STORED_PUBLIC,
        endpoint: "203.0.113.7:51820",
        address: "10.83.0.1/24",
      },
    });

    expect(record.wireguard?.address).toBe("10.83.0.1/24");
    expect((await getNode(ctx, NODE_A)).addresses).toEqual({
      internal: "10.83.0.1",
      apiPort: 7400,
    });
  });
});

describe("the interface configuration a node renders", () => {
  it("writes its own interface and one peer per other node on the tunnel", async () => {
    const registry = await fleet();

    const peers = await collectWireguardPeers(registry, NODE_A);
    const conf = renderWireguardConf({
      settings: {
        address: "10.83.0.1/24",
        host: "10.83.0.1",
        hostPrefix: 32,
        endpoint: "203.0.113.7:51820",
        port: 51_820,
      },
      privateKey: STORED_PRIVATE,
      peers,
    });

    expect(conf).toBe(
      [
        "[Interface]",
        "Address = 10.83.0.1/24",
        "ListenPort = 51820",
        `PrivateKey = ${STORED_PRIVATE}`,
        "",
        `# ${NODE_B}`,
        "[Peer]",
        `PublicKey = ${STORED_PUBLIC}`,
        "Endpoint = 203.0.113.8:51820",
        /* The peer's own address alone: allowing the /24 it names would claim
           every other node's route and leave the winner to section order. */
        "AllowedIPs = 10.83.0.2/32",
        "",
      ].join("\n"),
    );
  });

  it("leaves this node out of its own peer list", async () => {
    const registry = await fleet();

    const peers = await collectWireguardPeers(registry, NODE_A);

    expect(peers.map((peer) => peer.id)).toEqual([NODE_B]);
  });

  it("skips a node that is not on the tunnel yet rather than refusing to render", async () => {
    /* A fleet is migrated one node at a time, and the ones already tunnelled
       have to keep reaching each other while the rest catch up. */
    const registry = await fleet();
    await registerNode(registry, plainRecord(NODE_C, "10.0.0.9"));

    const peers = await collectWireguardPeers(registry, NODE_A);

    expect(peers.map((peer) => peer.id)).toEqual([NODE_B]);
  });

  it("skips a node that was deregistered while the list was being read", async () => {
    /* The listing and the reads are not one atomic view, and the coordinator
       deregisters nodes as it reaps them: a node that left mid-render is not a
       peer, and taking the whole fleet's configuration down over it is worse. */
    const registry = await fleet();
    await registerNode(registry, tunnelRecord(NODE_C, "10.83.0.3/24", "203.0.113.9:51820"));
    await registry.store.del(nodeKey(NODE_C));

    const peers = await collectWireguardPeers(registry, NODE_A);

    expect(peers.map((peer) => peer.id)).toEqual([NODE_B]);
  });

  it("orders peers by node id, so re-rendering an unchanged fleet changes nothing", async () => {
    const registry = await fleet();
    await registerNode(registry, tunnelRecord(NODE_C, "10.83.0.3/24", "203.0.113.9:51820"));

    const first = await collectWireguardPeers(registry, NODE_A);
    const second = await collectWireguardPeers(registry, NODE_A);

    expect(first.map((peer) => peer.id)).toEqual([NODE_B, NODE_C]);
    expect(second).toEqual(first);
  });

  it("routes an IPv6 peer as a single host too", async () => {
    const registry = await fleet();
    await registerNode(registry, tunnelRecord(NODE_C, "fd83::3/64", "[2001:db8::9]:51820"));

    const conf = renderWireguardConf({
      settings: {
        address: "fd83::1/64",
        host: "fd83::1",
        hostPrefix: 128,
        endpoint: "[2001:db8::7]:51820",
        port: 51_820,
      },
      privateKey: STORED_PRIVATE,
      peers: (await collectWireguardPeers(registry, NODE_A)).filter((peer) => peer.id === NODE_C),
    });

    expect(conf).toContain("AllowedIPs = fd83::3/128");
  });
});

/* ------------------------------------------------------------------ helpers */

/** A configuration for a node whose transport is the tunnel, with the defaults applied. */
async function tunnelConfig(env: Record<string, string> = {}): Promise<DaemonConfig> {
  return loadDaemonConfig({
    env: {
      ...REQUIRED_ENV,
      SCAFO_TRANSPORT: "wireguard",
      SCAFO_WG_ADDRESS: "10.83.0.1/24",
      SCAFO_WG_ENDPOINT: "203.0.113.7:51820",
      ...env,
    },
  });
}

/** Two registered nodes, both on the tunnel. */
async function fleet(): Promise<RegistryContext> {
  const { ctx } = ctxWith(new MemoryCasStore());
  await registerNode(ctx, tunnelRecord(NODE_A, "10.83.0.1/24", "203.0.113.7:51820"));
  await registerNode(ctx, tunnelRecord(NODE_B, "10.83.0.2/24", "203.0.113.8:51820"));
  return ctx;
}

function tunnelRecord(id: string, address: string, endpoint: string): NodeRecord {
  return {
    ...plainRecord(id, address.split("/")[0] as string),
    wireguard: { publicKey: STORED_PUBLIC, endpoint, address },
  };
}

function plainRecord(id: string, internal: string): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: "x" },
    addresses: { internal, apiPort: 7400 },
  };
}

/** Just enough identity for `registerThisNode`; the tunnel keys are separate. */
function nodeState(id: string): NodeState {
  return {
    id,
    privateKey: { kty: "OKP", crv: "Ed25519", x: "x", d: "d" },
    publicKey: { kty: "OKP", crv: "Ed25519", x: "x" },
  };
}

/** A valid WireGuard key: 32 bytes of `byte`, base64 exactly as the tool writes it. */
function wgKey(byte: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
}

async function writeKeys(dir: string, privateKey: string, publicKey: string): Promise<void> {
  await writeFile(join(dir, WG_PRIVATE_KEY_FILE), `${privateKey}\n`);
  await writeFile(join(dir, WG_PUBLIC_KEY_FILE), `${publicKey}\n`);
}

/** A state directory of this run's own, created the way the node would create it. */
async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scafo-wg-"));
  roots.push(root);
  const dir = join(root, "state");
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

async function emptyDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scafo-wg-path-"));
  roots.push(root);
  return root;
}

/** Makes `dir` the whole of PATH, so what `wg` resolves to is this suite's business. */
async function usePath(dir: string): Promise<void> {
  vi.stubEnv("PATH", dir);
}

/**
 * Puts a `wg` on PATH that prints fixed keys.
 *
 * A script rather than a mocked module: what is under test is that scafo shells
 * out to the operator's own tool for key material and computes none itself, and
 * a stub of the child process would test the opposite.
 */
async function useShim(): Promise<void> {
  const dir = await emptyDir();
  const path = join(dir, "wg");
  await writeFile(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      `  genkey) echo "${SHIM_PRIVATE}" ;;`,
      /* `wg pubkey` reads the private key on stdin; draining it keeps the
         caller's write from failing on a closed pipe. */
      `  pubkey) cat > /dev/null; echo "${SHIM_PUBLIC}" ;;`,
      '  *) echo "unexpected: $*" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  await usePath(dir);
}
