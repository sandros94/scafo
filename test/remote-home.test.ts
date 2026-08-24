/*
 * The operator's own home: where it is, what it is made of, and who may read it.
 *
 * Every case runs against a temporary home of its own, named by SCAFO_HOME, so
 * nothing here touches the home of whoever is running the suite.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addRemote, REMOTES_VERSION, readRemotes, writeRemotes } from "../src/cli/_remotes.ts";
import {
  HOME_CONFIG_FILE,
  homeConfigPath,
  homeKeyPath,
  KEYS_DIR,
  resolveOperatorHome,
  SCAFO_HOME_ENV,
} from "../src/cli/_home.ts";
import { rejectsWith } from "./_helpers.ts";

const homes: string[] = [];

afterAll(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
});

describe("where an operator's home is", () => {
  it("goes where SCAFO_HOME says, whatever the platform would have chosen", () => {
    expect(resolveOperatorHome({ [SCAFO_HOME_ENV]: "/srv/scafo-home" })).toBe("/srv/scafo-home");
  });

  it("follows the config convention of a machine that states one", () => {
    /* The same XDG convention a node's state directory already follows, read
       from the config half of it rather than the state half. */
    expect(resolveOperatorHome({ XDG_CONFIG_HOME: "/home/op/.config" })).toBe(
      "/home/op/.config/scafo",
    );
  });

  it("falls back to ~/.scafo when the machine states nothing", () => {
    expect(resolveOperatorHome({})).toBe(join(homedir(), ".scafo"));
  });

  it("refuses a relative SCAFO_HOME rather than reading it as a directory", async () => {
    /* Where the operator happened to be standing is not an identity: a relative
       home would be a different home on the next invocation. */
    const error = await rejectsWith(
      () => Promise.resolve(resolveOperatorHome({ [SCAFO_HOME_ENV]: "./scafo" })),
      "invalid-input",
    );

    expect(error.detail).toContain(SCAFO_HOME_ENV);
  });

  it("names the registry and a key inside it", () => {
    expect(homeConfigPath("/srv/h")).toBe(join("/srv/h", HOME_CONFIG_FILE));
    expect(homeKeyPath("/srv/h", "prod")).toBe(join("/srv/h", KEYS_DIR, "prod.json"));
  });
});

describe("the remote registry file", () => {
  it("reads as empty when the operator has no home yet", async () => {
    const home = join(await scratch(), "never-created");

    expect(await readRemotes(home)).toEqual({ v: REMOTES_VERSION, remotes: {} });
  });

  it("creates a home only its owner can enter, and a registry only its owner can read", async () => {
    const home = await scratch();

    await writeRemotes(home, { v: REMOTES_VERSION, remotes: {} });

    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(homeConfigPath(home))).mode & 0o777).toBe(0o600);
  });

  it("reads back what it wrote, comments and all", async () => {
    const home = await scratch();
    await writeRemotes(home, {
      v: REMOTES_VERSION,
      remotes: {
        prod: { endpoints: ["http://a:7400"], key: { kind: "file", path: "keys/prod.json" } },
      },
    });

    /* Written as JSONC and read as JSONC: the header explaining what the file is
       has to survive being read back. */
    expect(await readFile(homeConfigPath(home), "utf8")).toContain("/*");
    expect((await readRemotes(home)).remotes.prod?.endpoints).toEqual(["http://a:7400"]);
  });

  it("refuses a registry file it cannot read rather than starting an empty one", async () => {
    const home = await scratch();
    await writeRemotes(home, { v: REMOTES_VERSION, remotes: {} });
    /* A home that silently forgot every remote would send the next command
       somewhere else entirely, or nowhere at all. */
    await writeFile(homeConfigPath(home), "{ not json", "utf8");

    await rejectsWith(() => readRemotes(home), "invalid-input");
  });
});

describe("the key files a home keeps", () => {
  it("writes a fresh key only its owner can read, in a directory only its owner can enter", async () => {
    const home = await scratch();

    const added = await addRemote(home, { name: "prod", endpoints: ["http://a:7400"] });

    expect(added.keyPath).toBe(homeKeyPath(home, "prod"));
    expect((await stat(added.keyPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, KEYS_DIR))).mode & 0o777).toBe(0o700);
  });
});

/* ------------------------------------------------------------------ helpers */

async function scratch(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "scafo-home-"));
  homes.push(home);
  return home;
}
