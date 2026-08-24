/*
 * `scafo fleet add|list|remove|export`: what registering a fleet writes, what
 * unregistering one takes away, and the portable file that carries one fleet to
 * a machine that has never seen this installation.
 *
 * Every case runs against a temporary home of its own, so nothing here touches
 * the home of whoever is running the suite.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addFleet,
  exportFleet,
  formatFleetList,
  readFleets,
  removeFleet,
  STDOUT_KEY_WARNING,
} from "../src/cli/_fleets.ts";
import { homeKeyPath } from "../src/cli/_home.ts";
import {
  INLINE_PREFIX,
  type OperatorKeyFile,
  PORTABLE_KIND,
  PORTABLE_VERSION,
  type PortableOperator,
} from "../src/cli/_operator-key.ts";
import { toBase64 } from "../src/core/utils/base64.ts";
import { rejectsWith } from "./_helpers.ts";

const ENDPOINT = "http://10.0.0.4:7400";
const OTHER_ENDPOINT = "http://10.0.0.5:7400";

const homes: string[] = [];

afterAll(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
});

describe("registering a fleet", () => {
  it("mints a key named after the fleet and files both", async () => {
    const home = await scratch();

    const added = await addFleet(home, { name: "prod", endpoints: [ENDPOINT] });

    expect(added.minted).toBe(true);
    expect(added.key.id).toMatch(/^op-[0-9a-f]{8}$/);
    const entry = (await readFleets(home)).fleets.prod;
    expect(entry?.endpoints).toEqual([ENDPOINT]);
    expect(entry?.key).toEqual({ kind: "file", path: `keys/prod.json` });
    /* Filed by a path RELATIVE to the home, so a home that is copied or moved
       still points at its own keys. */
    const stored = JSON.parse(await readFile(homeKeyPath(home, "prod"), "utf8")) as OperatorKeyFile;
    expect(stored.id).toBe(added.key.id);
  });

  it("reuses a named key, so one key can serve several fleets", async () => {
    const home = await scratch();
    const first = await addFleet(home, { name: "prod", endpoints: [ENDPOINT] });

    const second = await addFleet(home, {
      name: "staging",
      endpoints: [OTHER_ENDPOINT],
      keyName: "prod",
    });

    expect(second.minted).toBe(false);
    expect(second.key.id).toBe(first.key.id);
    expect((await readFleets(home)).fleets.staging?.key).toEqual({
      kind: "file",
      path: `keys/prod.json`,
    });
  });

  it("refuses a --key naming a key the home does not hold", async () => {
    const home = await scratch();

    const error = await rejectsWith(
      () => addFleet(home, { name: "prod", endpoints: [ENDPOINT], keyName: "ghost" }),
      "not-found",
    );

    expect(error.detail).toContain("ghost");
  });

  it("refuses to overwrite a fleet that is already registered", async () => {
    const home = await scratch();
    await addFleet(home, { name: "prod", endpoints: [ENDPOINT] });

    const error = await rejectsWith(
      () => addFleet(home, { name: "prod", endpoints: [OTHER_ENDPOINT] }),
      "invalid-input",
    );

    /* Overwriting silently would strand the key the old entry pointed at and
       send every later command somewhere else. */
    expect(error.detail).toContain("scafo fleet remove");
  });

  it("refuses a name that could not be a file in the home", async () => {
    const home = await scratch();

    await rejectsWith(
      () => addFleet(home, { name: "../../etc/passwd", endpoints: [ENDPOINT] }),
      "invalid-slug",
    );
  });

  it("refuses a fleet with no endpoint, which nothing could reach", async () => {
    const home = await scratch();

    const error = await rejectsWith(
      () => addFleet(home, { name: "prod", endpoints: [] }),
      "invalid-input",
    );

    expect(error.detail).toContain("--endpoint");
  });
});

describe("importing a fleet from a portable file", () => {
  it("takes one in from a path", async () => {
    const home = await scratch();
    const path = join(home, "portable.json");
    await writeFile(path, `${JSON.stringify(await portable("prod"))}\n`, "utf8");

    const added = await addFleet(home, { from: path });

    expect(added.name).toBe("prod");
    expect(added.minted).toBe(false);
    expect((await readFleets(home)).fleets.prod?.endpoints).toEqual([ENDPOINT]);
  });

  it("takes one in from an inline base64: value", async () => {
    const home = await scratch();
    const file = await portable("prod");

    const added = await addFleet(home, { from: inline(file) });

    expect(added.key.id).toBe(file.key.id);
    expect((await readFleets(home)).fleets.prod?.endpoints).toEqual([ENDPOINT]);
  });

  it("lets the command name the fleet something else", async () => {
    const home = await scratch();

    const added = await addFleet(home, { name: "eu", from: inline(await portable("prod")) });

    expect(added.name).toBe("eu");
    expect(Object.keys((await readFleets(home)).fleets)).toEqual(["eu"]);
  });

  it("refuses a portable file that names no fleet when the command names none either", async () => {
    const home = await scratch();

    const error = await rejectsWith(
      async () => addFleet(home, { from: inline(await portable(undefined)) }),
      "invalid-input",
    );

    expect(error.detail).toContain("name");
  });

  it("refuses a base64: value that is not a portable file, with a failure that says so", async () => {
    const home = await scratch();

    const error = await rejectsWith(
      () => addFleet(home, { name: "prod", from: `${INLINE_PREFIX}!!!not-base64!!!` }),
      "invalid-input",
    );

    expect(error.detail).toContain(INLINE_PREFIX);
  });

  it("reads anything without the prefix as a path, however much it looks like base64", async () => {
    const home = await scratch();

    /* THE PREFIX DECIDES. A path that is not there is a path failure, and never
       a value quietly decoded instead. */
    const error = await rejectsWith(
      () => addFleet(home, { name: "prod", from: "eyJ2IjoxfQ==" }),
      "invalid-input",
    );

    expect(error.message).toContain("could not be read");
    expect(error.detail).toContain("eyJ2IjoxfQ==");
  });
});

describe("listing the fleets a home holds", () => {
  it("names each fleet, where it is reached and the key that speaks for it", async () => {
    const home = await scratch();
    await addFleet(home, { name: "prod", endpoints: [ENDPOINT] });
    await addFleet(home, { name: "staging", endpoints: [OTHER_ENDPOINT], keyName: "prod" });

    const printed = formatFleetList(await readFleets(home));

    expect(printed).toContain("prod");
    expect(printed).toContain(ENDPOINT);
    expect(printed).toContain("staging");
    expect(printed).toContain(OTHER_ENDPOINT);
    expect(printed).toContain("keys/prod.json");
  });

  it("says plainly when there is nothing registered", async () => {
    expect(formatFleetList(await readFleets(await scratch()))).toContain("scafo fleet add");
  });
});

describe("unregistering a fleet", () => {
  it("takes the entry and the key nothing else references", async () => {
    const home = await scratch();
    await addFleet(home, { name: "prod", endpoints: [ENDPOINT] });

    const removed = await removeFleet(home, "prod");

    expect(removed.keyRemoved).toBe(true);
    expect(Object.keys((await readFleets(home)).fleets)).toEqual([]);
    await expect(stat(homeKeyPath(home, "prod"))).rejects.toThrow(/ENOENT/);
  });

  it("keeps a key another fleet still speaks with, and says which", async () => {
    const home = await scratch();
    await addFleet(home, { name: "prod", endpoints: [ENDPOINT] });
    await addFleet(home, { name: "staging", endpoints: [OTHER_ENDPOINT], keyName: "prod" });

    const removed = await removeFleet(home, "prod");

    expect(removed.keyRemoved).toBe(false);
    expect(removed.sharedWith).toEqual(["staging"]);
    /* The key outlives the fleet it was named after: "staging" still signs with
       it, and deleting it would take that fleet down with this one. */
    expect((await stat(homeKeyPath(home, "prod"))).isFile()).toBe(true);
  });

  it("reports a fleet that is not registered rather than doing nothing quietly", async () => {
    const home = await scratch();

    await rejectsWith(() => removeFleet(home, "ghost"), "not-found");
  });
});

describe("exporting a fleet", () => {
  it("prints the whole portable file on stdout", async () => {
    const home = await scratch();
    const added = await addFleet(home, { name: "prod", endpoints: [ENDPOINT] });
    const lines: string[] = [];

    await exportFleet(home, "prod", { write: (line) => lines.push(line) });

    const printed = JSON.parse(lines.join("\n")) as PortableOperator;
    expect(printed).toMatchObject({ v: PORTABLE_VERSION, kind: PORTABLE_KIND, fleet: "prod" });
    expect(printed.endpoints).toEqual([ENDPOINT]);
    expect(printed.key.privateKey.d).toBe(added.key.privateKey.d);
  });

  it("says nothing on stdout when it is asked for a file, and writes it 0600", async () => {
    const home = await scratch();
    await addFleet(home, { name: "prod", endpoints: [ENDPOINT] });
    const out = join(home, "prod.operator.json");
    const lines: string[] = [];

    await exportFleet(home, "prod", { out, write: (line) => lines.push(line) });

    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({ fleet: "prod" });
    expect(lines.join("\n")).not.toContain("privateKey");
  });

  it("warns before it puts a private key on a terminal", async () => {
    const home = await scratch();
    await addFleet(home, { name: "prod", endpoints: [ENDPOINT] });
    const warnings: string[] = [];

    await exportFleet(home, "prod", {
      isTTY: true,
      write: () => {},
      warn: (l) => warnings.push(l),
    });

    expect(warnings.join("\n")).toBe(STDOUT_KEY_WARNING);
  });

  it("says nothing extra when it is piped somewhere", async () => {
    const home = await scratch();
    await addFleet(home, { name: "prod", endpoints: [ENDPOINT] });
    const warnings: string[] = [];

    await exportFleet(home, "prod", {
      isTTY: false,
      write: () => {},
      warn: (l) => warnings.push(l),
    });

    expect(warnings).toEqual([]);
  });

  it("reports a fleet that is not registered", async () => {
    const home = await scratch();

    await rejectsWith(() => exportFleet(home, "ghost", { write: () => {} }), "not-found");
  });
});

/* ------------------------------------------------------------------ helpers */

async function scratch(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "scafo-fleet-"));
  homes.push(home);
  return home;
}

/** A portable file built the only way one is ever built: by exporting a fleet. */
async function portable(fleet: string | undefined): Promise<PortableOperator> {
  const home = await scratch();
  await addFleet(home, { name: "prod", endpoints: [ENDPOINT] });

  const lines: string[] = [];
  await exportFleet(home, "prod", { write: (line) => lines.push(line) });
  const file = JSON.parse(lines.join("\n")) as PortableOperator;

  if (fleet !== undefined) return { ...file, fleet };
  const { fleet: _dropped, ...rest } = file;
  return rest;
}

function inline(file: PortableOperator): string {
  return INLINE_PREFIX + toBase64(new TextEncoder().encode(JSON.stringify(file)));
}

describe("the endpoints one --endpoint value may carry", () => {
  it("splits a comma-separated value into every endpoint it names", async () => {
    const { urls } = await import("../src/cli/commands/fleet.ts");
    expect(urls("http://a:7400,http://b:7400")).toEqual(["http://a:7400", "http://b:7400"]);
  });

  it("trims around the commas and drops empty entries", async () => {
    const { urls } = await import("../src/cli/commands/fleet.ts");
    expect(urls(" http://a:7400 , ,http://b:7400,")).toEqual(["http://a:7400", "http://b:7400"]);
  });

  it("keeps a single plain value as the one-entry list it is", async () => {
    const { urls } = await import("../src/cli/commands/fleet.ts");
    expect(urls("http://a:7400")).toEqual(["http://a:7400"]);
  });
});
