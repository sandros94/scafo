/*
 * `scafo remote add|list|remove|export`: what registering a remote writes, what unregistering one
 * takes away, and the portable file that carries one remote to a machine that has never seen this
 * installation.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addRemote,
  exportRemote,
  formatRemoteList,
  readRemotes,
  removeRemote,
  STDOUT_KEY_WARNING,
} from "../src/cli/_remotes.ts";
import { homeKeyPath } from "../src/cli/_home.ts";
import {
  generateOperatorKey,
  INLINE_PREFIX,
  type OperatorKeyFile,
  PORTABLE_KIND,
  PORTABLE_VERSION,
  type PortableOperator,
  registerOperatorKey,
} from "../src/cli/_operator-key.ts";
import { getOperator } from "../src/core/registry/operators.ts";
import { toBase64 } from "../src/core/utils/base64.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, rejectsWith } from "./_helpers.ts";

const ENDPOINT = "http://10.0.0.4:7400";
const OTHER_ENDPOINT = "http://10.0.0.5:7400";

const homes: string[] = [];

afterAll(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
});

describe("registering a remote", () => {
  it("mints a key named after the remote and files both", async () => {
    const home = await scratch();

    const added = await addRemote(home, { name: "prod", endpoints: [ENDPOINT] });

    expect(added.minted).toBe(true);
    expect(added.key.id).toMatch(/^op-[0-9a-f]{8}$/);
    const entry = (await readRemotes(home)).remotes.prod;
    expect(entry?.endpoints).toEqual([ENDPOINT]);
    expect(entry?.key).toEqual({ kind: "file", path: `keys/prod.json` });
    /* Filed by a path RELATIVE to the home, so a home that is copied or moved
       still points at its own keys. */
    const stored = JSON.parse(await readFile(homeKeyPath(home, "prod"), "utf8")) as OperatorKeyFile;
    expect(stored.id).toBe(added.key.id);
  });

  it("reuses a named key, so one key can serve several remotes", async () => {
    const home = await scratch();
    const first = await addRemote(home, { name: "prod", endpoints: [ENDPOINT] });

    const second = await addRemote(home, {
      name: "staging",
      endpoints: [OTHER_ENDPOINT],
      keyName: "prod",
    });

    expect(second.minted).toBe(false);
    expect(second.key.id).toBe(first.key.id);
    expect((await readRemotes(home)).remotes.staging?.key).toEqual({
      kind: "file",
      path: `keys/prod.json`,
    });
  });

  it("refuses a --key naming a key the home does not hold", async () => {
    const home = await scratch();

    const error = await rejectsWith(
      () => addRemote(home, { name: "prod", endpoints: [ENDPOINT], keyName: "ghost" }),
      "not-found",
    );

    expect(error.detail).toContain("ghost");
  });

  it("refuses to overwrite a remote that is already registered", async () => {
    const home = await scratch();
    await addRemote(home, { name: "prod", endpoints: [ENDPOINT] });

    const error = await rejectsWith(
      () => addRemote(home, { name: "prod", endpoints: [OTHER_ENDPOINT] }),
      "invalid-input",
    );

    /* Overwriting silently would strand the key the old entry pointed at and
       send every later command somewhere else. */
    expect(error.detail).toContain("scafo remote remove");
  });

  it("refuses a name that could not be a file in the home", async () => {
    const home = await scratch();

    await rejectsWith(
      () => addRemote(home, { name: "../../etc/passwd", endpoints: [ENDPOINT] }),
      "invalid-slug",
    );
  });

  it("refuses a remote with no endpoint, which nothing could reach", async () => {
    const home = await scratch();

    const error = await rejectsWith(
      () => addRemote(home, { name: "prod", endpoints: [] }),
      "invalid-input",
    );

    expect(error.detail).toContain("--endpoint");
  });
});

describe("importing a remote from a portable file", () => {
  it("takes one in from a path", async () => {
    const home = await scratch();
    const path = join(home, "portable.json");
    await writeFile(path, `${JSON.stringify(await portable("prod"))}\n`, "utf8");

    const added = await addRemote(home, { from: path });

    expect(added.name).toBe("prod");
    expect(added.minted).toBe(false);
    expect((await readRemotes(home)).remotes.prod?.endpoints).toEqual([ENDPOINT]);
  });

  it("takes one in from an inline base64: value", async () => {
    const home = await scratch();
    const file = await portable("prod");

    const added = await addRemote(home, { from: inline(file) });

    expect(added.key.id).toBe(file.key.id);
    expect((await readRemotes(home)).remotes.prod?.endpoints).toEqual([ENDPOINT]);
  });

  it("lets the command name the remote something else", async () => {
    const home = await scratch();

    const added = await addRemote(home, { name: "eu", from: inline(await portable("prod")) });

    expect(added.name).toBe("eu");
    expect(Object.keys((await readRemotes(home)).remotes)).toEqual(["eu"]);
  });

  it("refuses a portable file that names no remote when the command names none either", async () => {
    const home = await scratch();

    const error = await rejectsWith(
      async () => addRemote(home, { from: inline(await portable(undefined)) }),
      "invalid-input",
    );

    expect(error.detail).toContain("name");
  });

  it("refuses a base64: value that is not a portable file, with a failure that says so", async () => {
    const home = await scratch();

    const error = await rejectsWith(
      () => addRemote(home, { name: "prod", from: `${INLINE_PREFIX}!!!not-base64!!!` }),
      "invalid-input",
    );

    expect(error.detail).toContain(INLINE_PREFIX);
  });

  it("reads anything without the prefix as a path, however much it looks like base64", async () => {
    const home = await scratch();

    /* the prefix DECIDES. A path that is not there is a path failure, and never
       a value quietly decoded instead. */
    const error = await rejectsWith(
      () => addRemote(home, { name: "prod", from: "eyJ2IjoxfQ==" }),
      "invalid-input",
    );

    expect(error.message).toContain("could not be read");
    expect(error.detail).toContain("eyJ2IjoxfQ==");
  });
});

describe("listing the remotes a home holds", () => {
  it("names each remote, where it is reached and the key that speaks for it", async () => {
    const home = await scratch();
    await addRemote(home, { name: "prod", endpoints: [ENDPOINT] });
    await addRemote(home, { name: "staging", endpoints: [OTHER_ENDPOINT], keyName: "prod" });

    const printed = formatRemoteList(await readRemotes(home));

    expect(printed).toContain("prod");
    expect(printed).toContain(ENDPOINT);
    expect(printed).toContain("staging");
    expect(printed).toContain(OTHER_ENDPOINT);
    expect(printed).toContain("keys/prod.json");
  });

  it("says plainly when there is nothing registered", async () => {
    expect(formatRemoteList(await readRemotes(await scratch()))).toContain("scafo remote add");
  });
});

describe("unregistering a remote", () => {
  it("takes the entry and the key nothing else references", async () => {
    const home = await scratch();
    await addRemote(home, { name: "prod", endpoints: [ENDPOINT] });

    const removed = await removeRemote(home, "prod");

    expect(removed.keyRemoved).toBe(true);
    expect(Object.keys((await readRemotes(home)).remotes)).toEqual([]);
    await expect(stat(homeKeyPath(home, "prod"))).rejects.toThrow(/ENOENT/);
  });

  it("keeps a key another remote still speaks with, and says which", async () => {
    const home = await scratch();
    await addRemote(home, { name: "prod", endpoints: [ENDPOINT] });
    await addRemote(home, { name: "staging", endpoints: [OTHER_ENDPOINT], keyName: "prod" });

    const removed = await removeRemote(home, "prod");

    expect(removed.keyRemoved).toBe(false);
    expect(removed.sharedWith).toEqual(["staging"]);
    /* The key outlives the remote it was named after: "staging" still signs with
       it, and deleting it would take that remote down with this one. */
    expect((await stat(homeKeyPath(home, "prod"))).isFile()).toBe(true);
  });

  it("reports a remote that is not registered rather than doing nothing quietly", async () => {
    const home = await scratch();

    await rejectsWith(() => removeRemote(home, "ghost"), "not-found");
  });
});

describe("exporting a remote", () => {
  it("prints the whole portable file on stdout", async () => {
    const home = await scratch();
    const added = await addRemote(home, { name: "prod", endpoints: [ENDPOINT] });
    const lines: string[] = [];

    await exportRemote(home, "prod", { write: (line) => lines.push(line) });

    const printed = JSON.parse(lines.join("\n")) as PortableOperator;
    expect(printed).toMatchObject({ v: PORTABLE_VERSION, kind: PORTABLE_KIND, remote: "prod" });
    expect(printed.endpoints).toEqual([ENDPOINT]);
    expect(printed.key.privateKey.d).toBe(added.key.privateKey.d);
  });

  it("says nothing on stdout when it is asked for a file, and writes it 0600", async () => {
    const home = await scratch();
    await addRemote(home, { name: "prod", endpoints: [ENDPOINT] });
    const out = join(home, "prod.operator.json");
    const lines: string[] = [];

    await exportRemote(home, "prod", { out, write: (line) => lines.push(line) });

    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({ remote: "prod" });
    expect(lines.join("\n")).not.toContain("privateKey");
  });

  it("warns before it puts a private key on a terminal", async () => {
    const home = await scratch();
    await addRemote(home, { name: "prod", endpoints: [ENDPOINT] });
    const warnings: string[] = [];

    await exportRemote(home, "prod", {
      isTTY: true,
      write: () => {},
      warn: (l) => warnings.push(l),
    });

    expect(warnings.join("\n")).toBe(STDOUT_KEY_WARNING);
  });

  it("says nothing extra when it is piped somewhere", async () => {
    const home = await scratch();
    await addRemote(home, { name: "prod", endpoints: [ENDPOINT] });
    const warnings: string[] = [];

    await exportRemote(home, "prod", {
      isTTY: false,
      write: () => {},
      warn: (l) => warnings.push(l),
    });

    expect(warnings).toEqual([]);
  });

  it("reports a remote that is not registered", async () => {
    const home = await scratch();

    await rejectsWith(() => exportRemote(home, "ghost", { write: () => {} }), "not-found");
  });
});

async function scratch(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "scafo-remote-"));
  homes.push(home);
  return home;
}

/** A portable file built the only way one is ever built: by exporting a remote. */
async function portable(remote: string | undefined): Promise<PortableOperator> {
  const home = await scratch();
  await addRemote(home, { name: "prod", endpoints: [ENDPOINT] });

  const lines: string[] = [];
  await exportRemote(home, "prod", { write: (line) => lines.push(line) });
  const file = JSON.parse(lines.join("\n")) as PortableOperator;

  if (remote !== undefined) return { ...file, remote };
  const { remote: _dropped, ...rest } = file;
  return rest;
}

function inline(file: PortableOperator): string {
  return INLINE_PREFIX + toBase64(new TextEncoder().encode(JSON.stringify(file)));
}

describe("the endpoints one --endpoint value may carry", () => {
  it("splits a comma-separated value into every endpoint it names", async () => {
    const { urls } = await import("../src/cli/commands/remote.ts");
    expect(urls("http://a:7400,http://b:7400")).toEqual(["http://a:7400", "http://b:7400"]);
  });

  it("trims around the commas and drops empty entries", async () => {
    const { urls } = await import("../src/cli/commands/remote.ts");
    expect(urls(" http://a:7400 , ,http://b:7400,")).toEqual(["http://a:7400", "http://b:7400"]);
  });

  it("keeps a single plain value as the one-entry list it is", async () => {
    const { urls } = await import("../src/cli/commands/remote.ts");
    expect(urls("http://a:7400")).toEqual(["http://a:7400"]);
  });
});

describe("the tier a bucket-side registration files a key at", () => {
  it("makes the FIRST key of an installation an admin, whatever else is asked", async () => {
    const clock = ctxWith(new MemoryCasStore());
    const key = await generateOperatorKey();

    await registerOperatorKey(clock.ctx, key);

    /* A fleet must never exist with zero admins, and the first key is the only
       one there is to be one. */
    await expect(getOperator(clock.ctx, key.id)).resolves.toMatchObject({ role: "admin" });
  });

  it("REFUSES an explicit operator-tier first key rather than creating an adminless fleet", async () => {
    const clock = ctxWith(new MemoryCasStore());
    const key = await generateOperatorKey();

    const error = await rejectsWith(
      () => registerOperatorKey(clock.ctx, key, { role: "operator" }),
      "invalid-input",
    );

    expect(error.detail).toContain("admin");
    await expect(getOperator(clock.ctx, key.id)).resolves.toBeNull();
  });

  it("files a later key at the ADMIN tier when one is asked for", async () => {
    const clock = ctxWith(new MemoryCasStore());
    await registerOperatorKey(clock.ctx, await generateOperatorKey());
    const second = await generateOperatorKey();

    await registerOperatorKey(clock.ctx, second, { role: "admin" });

    await expect(getOperator(clock.ctx, second.id)).resolves.toMatchObject({ role: "admin" });
  });

  it("REFUSES a later key at the operator tier, because the ceremony grants no scope", async () => {
    const clock = ctxWith(new MemoryCasStore());
    await registerOperatorKey(clock.ctx, await generateOperatorKey());
    const second = await generateOperatorKey();

    /*
     * The ceremony admits a key with no projects named, and an operator-tier
     * key that names none reaches nothing — so what it would produce here is a
     * key that authenticates and can do nothing, filed by the one path with no
     * node in it to say so. It bypasses the TIER rules on purpose, because
     * there may be no admin to ask; it bypasses nothing about what a record may
     * say. Operator-tier keys are enrolled over the wire, with a scope.
     */
    const error = await rejectsWith(() => registerOperatorKey(clock.ctx, second), "invalid-input");

    expect(error.detail).toContain("projects");
    await expect(getOperator(clock.ctx, second.id)).resolves.toBeNull();
  });

  it("is asked for by --role on both commands that register a key", async () => {
    const { remote } = await import("../src/cli/commands/remote.ts");
    const { operator } = await import("../src/cli/commands/operator.ts");

    const keygen = (operator.subCommands as Record<string, { args?: Record<string, unknown> }>)
      .keygen;
    expect(keygen.args).toHaveProperty("role");
    expect(remote.subCommands).toBeDefined();
    const add = (remote.subCommands as Record<string, { args?: Record<string, unknown> }>).add;
    expect(add.args).toHaveProperty("role");
  });
});
