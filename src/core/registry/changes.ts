/*
 * The change hint: one small object that says "the registry moved since you last
 * looked", so an idle installation costs one GET a pass instead of a listing and
 * a read of every record it holds.
 *
 * IT IS A HINT. It carries no state anything is derived from, and no reader
 * trusts it for correctness: a token that never arrived costs a node the latency
 * of its next full resync, and a token that arrived for a write nobody cares
 * about costs one extra listing. Because of that it is written BLIND — no
 * precondition, last writer wins — so fifty concurrent deploys never contend on
 * it and never fail on it.
 */

import { safeJsonParse } from "unsecure/sanitize";
import { describeError } from "../error.ts";
import type { CasStore } from "../types/store.ts";
import type { RegistryContext } from "./context.ts";
import { applicationsPrefix, changesKey, domainsPrefix, placementPrefix } from "./paths.ts";

/** Shape version of the hint document. */
export const CHANGE_HINT_VERSION: number = 1;

/** Hexadecimal characters a token is made of; 64 bits is far past collision here. */
const TOKEN_BYTES = 8;

/** What the hint object holds. */
export interface ChangeHint {
  v: number;
  /** 16 lowercase hex characters; any value but the last one seen means "look again". */
  token: string;
}

/**
 * The prefixes a write of which is worth telling the fleet about at once.
 *
 * NODE RECORDS ARE NOT AMONG THEM, deliberately: every node rewrites its own
 * record every thirty seconds, so hinting them would mint a token — and cost
 * every node a listing — several times a minute forever, which is the cost this
 * hint exists to remove. Liveness is the AGE of a heartbeat rather than a write
 * anyone has to see, and it is read on the node-refresh timer instead. The one
 * thing a node changes that routing depends on — what it SERVES, and whether it
 * is draining — is hinted explicitly by the node that changed it.
 */
export const HINTED_PREFIXES: readonly string[] = [
  applicationsPrefix(),
  placementPrefix(),
  domainsPrefix(),
];

/** Whether a write of `key` is one the fleet should be told about at once. */
export function isHintedKey(key: string): boolean {
  return HINTED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** A fresh token: 16 lowercase hex characters. */
export function mintChangeToken(): string {
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * The token the hint currently carries, or null when there is no hint yet or it
 * says nothing readable.
 *
 * NEVER THROWS ON CONTENT: an unreadable hint is one nobody wrote — or one a
 * future version writes differently — and treating it as absent makes the reader
 * fall back to its resync timer, which is exactly the behaviour a lost hint has.
 * A store that could not be reached still throws, because that is a registry
 * read failing and the caller has to know.
 */
export async function readChangeHint(ctx: RegistryContext): Promise<string | null> {
  const object = await ctx.store.get(changesKey());
  if (object === null) return null;

  try {
    const hint = safeJsonParse<ChangeHint>(object.body);
    return typeof hint.token === "string" && hint.token !== "" ? hint.token : null;
  } catch {
    return null;
  }
}

/**
 * Writes a fresh token, blind.
 *
 * Answers the token it wrote, or null when the write did not land. It never
 * throws: every caller is past the mutation this follows, and a mutation that
 * HAPPENED must never be reported as failed because a hint did not.
 */
export async function writeChangeHint(
  store: CasStore,
  opts?: { onFailure?: (error: unknown) => void },
): Promise<string | null> {
  const token = mintChangeToken();
  const hint: ChangeHint = { v: CHANGE_HINT_VERSION, token };
  try {
    await store.put(changesKey(), JSON.stringify(hint, undefined, 2));
    return token;
  } catch (error) {
    opts?.onFailure?.(error);
    return null;
  }
}

export interface HintingStoreOptions {
  /**
   * Told when a hint could not be written. Defaults to one line on stderr: the
   * mutation itself went through, and the only cost is that nodes hear about it
   * on their resync timer rather than within a pass.
   */
  onFailure?: (error: unknown) => void;
}

/**
 * Wraps `inner` so that a successful write under a hinted prefix mints a fresh
 * change token.
 *
 * APPLIED WHERE THE REGISTRY CONTEXT IS BUILT, for the daemon and the CLI alike:
 * a bucket-direct `scafo app retire` run from an operator's laptop then hints
 * exactly as a deploy through a node does, and nothing has to remember to.
 *
 * A write that FAILED hints nothing — there is no change to tell anyone about —
 * and a hint that fails changes nothing about the write it follows.
 */
export function hintingStore(inner: CasStore, opts?: HintingStoreOptions): CasStore {
  const onFailure =
    opts?.onFailure ??
    ((error: unknown): void => {
      console.error(
        `scafo: the registry change hint could not be written (${describeError(error)}); ` +
          `nodes will notice this change on their next full resync instead`,
      );
    });

  const hint = async (key: string): Promise<void> => {
    if (!isHintedKey(key)) return;
    await writeChangeHint(inner, { onFailure });
  };

  return {
    get: (key) => inner.get(key),
    getBytes: (key, getOpts) => inner.getBytes(key, getOpts),
    head: (key) => inner.head(key),
    list: (prefix) => inner.list(prefix),
    listEntries: (prefix) => inner.listEntries(prefix),

    async put(key, body, cas): Promise<{ etag: string }> {
      const written = await inner.put(key, body, cas);
      await hint(key);
      return written;
    },

    async del(key): Promise<void> {
      await inner.del(key);
      await hint(key);
    },
  };
}
