/*
 * Internal: where an operator keeps their own scafo state — the remotes they can
 * reach and the keys that speak for them.
 *
 * This is the OPERATOR's home, not a node's state directory: a node is a machine
 * with an identity it must keep across boots, an operator is a person with
 * several installations they move between. Nothing in here is ever written by a
 * node daemon, and nothing in here belongs in a repository.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ScafoError } from "../core/error.ts";
import { isSlug } from "../core/utils/slug.ts";

/** Environment variable naming the home outright, whatever the platform would say. */
export const SCAFO_HOME_ENV: string = "SCAFO_HOME";

/** The remote registry, within the home. JSONC, so it can be commented by hand. */
export const HOME_CONFIG_FILE: string = "config.jsonc";

/** Directory the keypairs live in, within the home. */
export const KEYS_DIR: string = "keys";

/**
 * Where this operator's home is: {@link SCAFO_HOME_ENV} when it is set,
 * `$XDG_CONFIG_HOME/scafo` on a machine that states one, and `~/.scafo`
 * otherwise — the same XDG convention a node's state directory already follows,
 * read from the config half of it rather than the state half.
 *
 * ALWAYS ABSOLUTE. A relative {@link SCAFO_HOME_ENV} is REFUSED rather than
 * resolved against the working directory: an operator runs commands from
 * wherever they happen to be standing, and a home derived from that would be a
 * different home — a different set of remotes — on the next invocation.
 *
 * Throws `ScafoError("invalid-input")` for a relative override.
 */
export function resolveOperatorHome(env: Record<string, string | undefined> = process.env): string {
  const stated = env[SCAFO_HOME_ENV]?.trim();
  if (stated !== undefined && stated !== "") {
    if (!isAbsolute(stated)) {
      throw new ScafoError("invalid-input", "Operator home is not an absolute path", {
        detail:
          `${SCAFO_HOME_ENV} is "${stated}", which would name a different directory from ` +
          `every directory a command is run in; give an absolute path`,
      });
    }
    return stated;
  }

  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) return join(xdg, "scafo");
  return join(homedir(), ".scafo");
}

/** The remote registry file of a home. */
export function homeConfigPath(home: string): string {
  return join(home, HOME_CONFIG_FILE);
}

/** The directory a home keeps its keypairs in. */
export function homeKeysDir(home: string): string {
  return join(home, KEYS_DIR);
}

/** Where the key named `name` lives, as an absolute path. */
export function homeKeyPath(home: string, name: string): string {
  assertKeyName(name);
  return join(homeKeysDir(home), `${name}.json`);
}

/**
 * How a home REFERS to the key named `name`: relative to the home itself, so a
 * home that is copied or moved still points at its own keys.
 */
export function homeKeyRefPath(name: string): string {
  assertKeyName(name);
  return `${KEYS_DIR}/${name}.json`;
}

/** A path a home refers to, resolved against it when it is not absolute. */
export function resolveHomePath(home: string, path: string): string {
  return isAbsolute(path) ? path : join(home, path);
}

/**
 * Throws `ScafoError("invalid-slug")` for a remote or key name that could not
 * safely be a file in the home — which is the same charset every other name in
 * this system is held to.
 */
export function assertKeyName(name: string): void {
  if (isSlug(name)) return;

  throw new ScafoError("invalid-slug", "Invalid remote name", {
    detail:
      `"${name}" must be 1-63 lowercase alphanumeric characters, optionally separated by ` +
      `single hyphens; it names both a remote and the file its key lives in`,
  });
}
