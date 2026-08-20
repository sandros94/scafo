/*
 * Internal: the tunnel a node runs on — the settings that describe it, and the
 * X25519 keypair that speaks for it.
 *
 * scafo NEVER computes a WireGuard key. The private half comes from a file the
 * operator put in the state directory, or from `wg genkey` run once as a child
 * process; the public half comes from a file beside it, or from `wg pubkey`.
 * With neither the file nor the binary, this refuses and says which command to
 * run. The setup is assisted, not magical: an amateur curve25519 implementation
 * in the middle of an operator's private network is a worse outcome than an
 * error message.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "../agent/config.ts";
import { DEFAULT_WIREGUARD_PORT, describeWireguardSetting } from "../agent/config.ts";
import { ScafoError } from "../core/error.ts";
import { parseInterfaceAddress } from "../core/utils/host.ts";
import { resolveDefaultStateDir, writeSecretFile } from "./_utils.ts";

/** Private key file within the state directory, as `wg genkey` writes one. */
export const WG_PRIVATE_KEY_FILE: string = "wg-private.key";

/** Public key file within the state directory, as `wg pubkey` writes one. */
export const WG_PUBLIC_KEY_FILE: string = "wg-public.key";

/** Rendered interface configuration, ready for `wg-quick`. */
export const WG_CONF_FILE: string = "wg0.conf";

/** The tool this reaches for, resolved through `PATH`. */
export const WG_BINARY: string = "wg";

/** Where one half of the keypair came from, as `scafo wg init` reports it. */
export type WireguardKeySource = "state" | "wg";

/** The keypair this node's tunnel runs on, and where each half was found. */
export interface WireguardKeys {
  /** Base64, as `wg` prints it. Never written to the registry. */
  privateKey: string;
  /** Base64, as `wg pubkey` prints it. This is what peers are told. */
  publicKey: string;
  from: { privateKey: WireguardKeySource; publicKey: WireguardKeySource };
}

/** Where this node sits on the tunnel, once every setting it needs is known. */
export interface WireguardSettings {
  /** The interface address with its prefix length: `10.83.0.1/24`. */
  address: string;
  /** {@link WireguardSettings.address} with the prefix stripped: `10.83.0.1`. */
  host: string;
  /** Prefix that addresses this node alone, for a peer's `AllowedIPs`. */
  hostPrefix: number;
  /** `host:port` peers send this node's tunnel traffic to. */
  endpoint: string;
  /** UDP port the interface listens on. */
  port: number;
}

export interface WireguardOptions {
  /** Where the keys live, when the configuration names no state directory. */
  defaultStateDir?: string;
  /** Where an ignored configuration is reported. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Where this node keeps its tunnel keys and its rendered configuration: the
 * configured state directory, or the one the CLI resolves for the user it runs
 * as — the same directory the node's identity lives in.
 */
export function wireguardStateDir(config: AgentConfig, opts?: WireguardOptions): string {
  return config.node.stateDir ?? opts?.defaultStateDir ?? resolveDefaultStateDir();
}

/**
 * The tunnel this node runs on, or undefined when it runs none.
 *
 * Throws `ScafoError("invalid-input")` naming the missing setting when
 * `transport.driver` is `wireguard` and this node has not been told where it
 * sits: a node that registered itself without an address or an endpoint would
 * be a peer nothing else can build a route to.
 *
 * A tunnel configured on a node running another transport is not an error, but
 * it is not silently kept either — nothing reads it, and an operator who wrote
 * it meant something by it, so it is reported and dropped.
 */
export function resolveWireguardSettings(
  config: AgentConfig,
  opts?: WireguardOptions,
): WireguardSettings | undefined {
  const configured = config.wireguard;

  if (config.transport?.driver !== "wireguard") {
    if (configured !== undefined) {
      (opts?.warn ?? console.warn)(
        `scafo: warning: this node's WireGuard settings are ignored because ` +
          `${describeWireguardSetting("address")} only applies to a node whose transport is ` +
          `"wireguard"; set --transport wireguard to run the tunnel, or remove them`,
      );
    }
    return undefined;
  }

  const address = configured?.address;
  const endpoint = configured?.endpoint;
  if (address === undefined) throw missing("address");
  if (endpoint === undefined) throw missing("endpoint");

  /* Already checked by the loader; parsed again for the parts. */
  const parsed = parseInterfaceAddress(address);
  if (parsed === null) throw missing("address");

  return {
    address,
    host: parsed.host,
    hostPrefix: parsed.hostPrefix,
    endpoint,
    port: configured?.port ?? DEFAULT_WIREGUARD_PORT,
  };
}

/**
 * The keypair as it stands on disk, or null when this node has none yet.
 *
 * Reads only. Nothing here starts a process or writes a file, because this is
 * what `scafo up` calls: a node coming back up must not quietly mint an identity
 * its peers have never been told about.
 *
 * Throws `ScafoError("invalid-input")` when a key file exists but does not hold
 * a key, rather than replacing it.
 */
export async function readWireguardKeys(stateDir: string): Promise<WireguardKeys | null> {
  const privateKey = await readKeyFile(join(stateDir, WG_PRIVATE_KEY_FILE));
  if (privateKey === null) return null;

  const publicKey = await readKeyFile(join(stateDir, WG_PUBLIC_KEY_FILE));
  if (publicKey === null) return null;

  return { privateKey, publicKey, from: { privateKey: "state", publicKey: "state" } };
}

/**
 * The keypair, generating and persisting whichever half is missing.
 *
 * The private half is read from `<stateDir>/wg-private.key`, or made with
 * `wg genkey`; the public half from `<stateDir>/wg-public.key`, or derived with
 * `wg pubkey`. Both are written back `0600` so that no later call needs `wg`
 * again — a node whose tunnel is set up boots on a host that has never had
 * wireguard-tools installed.
 *
 * Throws `ScafoError("invalid-input")` when a half is missing and there is no
 * `wg` on `PATH`, naming the command that would produce it.
 */
export async function ensureWireguardKeys(stateDir: string): Promise<WireguardKeys> {
  const privatePath = join(stateDir, WG_PRIVATE_KEY_FILE);
  const publicPath = join(stateDir, WG_PUBLIC_KEY_FILE);

  const stored = await readKeyFile(privatePath);
  const privateKey = stored ?? (await generatePrivateKey(privatePath));
  if (stored === null) await writeSecretFile(stateDir, privatePath, `${privateKey}\n`);

  const storedPublic = await readKeyFile(publicPath);
  const publicKey = storedPublic ?? (await derivePublicKey(privateKey, privatePath, publicPath));
  if (storedPublic === null) await writeSecretFile(stateDir, publicPath, `${publicKey}\n`);

  if (stored !== null && storedPublic !== null) {
    await assertPair(privateKey, storedPublic, privatePath, publicPath);
  }

  return {
    privateKey,
    publicKey,
    from: {
      privateKey: stored === null ? "wg" : "state",
      publicKey: storedPublic === null ? "wg" : "state",
    },
  };
}

/**
 * Whether `value` is a WireGuard key: 32 bytes, base64 as the tool writes them.
 * Both halves of an X25519 pair are the same 32 bytes, so one check serves both.
 */
export function isWireguardKey(value: string): boolean {
  if (!/^[\d+/A-Za-z]{43}=$/.test(value)) return false;
  try {
    return atob(value).length === 32;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- internal */

async function generatePrivateKey(path: string): Promise<string> {
  const generated = await runWg(["genkey"]);
  if (generated === null) {
    throw new ScafoError("invalid-input", "No WireGuard private key", {
      detail:
        `this node has no key at "${path}" and no "${WG_BINARY}" on PATH to make one with: ` +
        `run "${WG_BINARY} genkey > ${path}" and "chmod 600 ${path}", or install ` +
        `wireguard-tools and run "scafo wg init" again — scafo never derives an X25519 key ` +
        `itself, so the key material is only ever the operator's own`,
    });
  }
  return assertKey(generated, `"${WG_BINARY} genkey"`);
}

async function derivePublicKey(
  privateKey: string,
  privatePath: string,
  publicPath: string,
): Promise<string> {
  const derived = await runWg(["pubkey"], `${privateKey}\n`);
  if (derived === null) {
    throw new ScafoError("invalid-input", "No WireGuard public key", {
      detail:
        `"${privatePath}" holds this node's private key, but there is no "${publicPath}" and ` +
        `no "${WG_BINARY}" on PATH to derive the public half with: run ` +
        `"${WG_BINARY} pubkey < ${privatePath} > ${publicPath}", or install wireguard-tools ` +
        `and run "scafo wg init" again`,
    });
  }
  return assertKey(derived, `"${WG_BINARY} pubkey"`);
}

/**
 * Checks that two key files on disk are actually halves of one pair.
 *
 * The failure this catches is quiet and expensive: an operator who re-runs
 * `wg genkey > wg-private.key` and leaves the old public key behind publishes a
 * key no peer's handshake will ever complete against, while every file involved
 * looks correct. Nothing but `wg` can tell, so this only runs where `wg` is
 * there — a host without it keeps whatever it was given, which is the same limit
 * every other path here has.
 */
async function assertPair(
  privateKey: string,
  publicKey: string,
  privatePath: string,
  publicPath: string,
): Promise<void> {
  const derived = await runWg(["pubkey"], `${privateKey}\n`);
  if (derived === null || derived.trim() === publicKey) return;

  throw new ScafoError("invalid-input", "WireGuard keys are not a pair", {
    detail:
      `"${publicPath}" does not hold the public half of the private key in "${privatePath}": ` +
      `"${WG_BINARY} pubkey" derives "${derived.trim()}" from it. Peers told the key in the ` +
      `public file would never complete a handshake with this node — delete "${publicPath}" ` +
      `to have it derived again, or restore the private key it belongs to`,
  });
}

/** The key a file holds, or null when the file is not there. */
async function readKeyFile(path: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  return assertKey(text, `"${path}"`);
}

function assertKey(text: string, what: string): string {
  const key = text.trim();
  if (isWireguardKey(key)) return key;

  throw new ScafoError("invalid-input", "WireGuard key is unusable", {
    detail:
      `${what} does not hold a WireGuard key: one is 32 bytes written as 44 base64 ` +
      `characters, exactly as "${WG_BINARY} genkey" prints it`,
  });
}

/**
 * Runs `wg` once and hands back what it printed, or null when there is no `wg`
 * on `PATH`. A `wg` that runs and fails is a different matter and is raised.
 *
 * No shell, so nothing here is interpolated into a command line, and the private
 * key is passed on stdin rather than as an argument that every process on the
 * machine could read out of `/proc`.
 */
function runWg(args: string[], input?: string): Promise<string | null> {
  return new Promise<string | null>((settle, fail) => {
    const child = spawn(WG_BINARY, args, { stdio: ["pipe", "pipe", "pipe"] });

    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.stderr.on("data", (chunk: string) => (err += chunk));

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        settle(null);
        return;
      }
      fail(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        settle(out);
        return;
      }
      fail(
        new ScafoError("invalid-input", "WireGuard tooling failed", {
          detail:
            `"${WG_BINARY} ${args.join(" ")}" exited with code ${String(code)}` +
            `${err.trim() === "" ? "" : `: ${err.trim()}`}`,
        }),
      );
    });

    /*
     * `wg genkey` never reads its stdin and exits as soon as it has printed, so
     * closing the pipe races it and raises EPIPE. That is not a failure of
     * anything: whether the tool did its job is the exit code and the output
     * below, both of which are still checked.
     */
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

function missing(setting: "address" | "endpoint"): ScafoError {
  const what =
    setting === "address"
      ? `the address this node's own tunnel interface takes, with its prefix length ` +
        `(such as "10.83.0.1/24")`
      : `the "host:port" this node's peers send its tunnel traffic to ` +
        `(such as "203.0.113.7:51820")`;

  return new ScafoError("invalid-input", "Incomplete WireGuard configuration", {
    detail:
      `this node's transport is "wireguard", so ${describeWireguardSetting(setting)} must give ` +
      `${what}; without it this node would register itself as a peer nothing can route to`,
  });
}
