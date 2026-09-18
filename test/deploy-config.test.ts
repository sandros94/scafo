/*
 * The one place a runtime config is edited: client-side, in memory, and only
 * when a flag asked for it. What is packed is what the runtime reads, so these
 * cases are about the exact text that ends up in the archive.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editedConfig, isEmptyEdit, parseVarFlags } from "../src/cli/_deploy-config.ts";
import { rejectsWith } from "./_helpers.ts";

const FLAG = "--var";

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "scafo-deploy-config-"));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("the variables a deploy was given on the command line", () => {
  it("splits each pair at its first colon and takes the rest verbatim", () => {
    expect(parseVarFlags(["URL:https://db.test:5432/app", "EMPTY:"], FLAG)).toEqual({
      URL: "https://db.test:5432/app",
      EMPTY: "",
    });
  });

  it("refuses a pair with no colon at all", async () => {
    const error = await rejectsWith(
      () => Promise.resolve(parseVarFlags(["JUST_A_NAME"], FLAG)),
      "invalid-input",
    );

    expect(error.detail).toContain("KEY:VALUE");
  });

  it("refuses an empty name", async () => {
    const error = await rejectsWith(
      () => Promise.resolve(parseVarFlags([":value"], FLAG)),
      "invalid-input",
    );

    expect(error.detail).toContain(FLAG);
  });

  it("refuses the same name twice rather than picking a winner", async () => {
    const error = await rejectsWith(
      () => Promise.resolve(parseVarFlags(["A:1", "A:2"], FLAG)),
      "invalid-input",
    );

    expect(error.detail).toContain("twice");
    expect(error.detail).toContain('"A"');
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "refuses %s, which every object answers for on its own",
    async (name) => {
      const error = await rejectsWith(
        () => Promise.resolve(parseVarFlags([`${name}:1`], FLAG)),
        "invalid-input",
      );

      expect(error.detail).toContain(name);
    },
  );
});

describe("whether anything is edited at all", () => {
  it("is nothing to do without a flag, and something to do with either", () => {
    expect(isEmptyEdit({ vars: {}, noBundle: false })).toBe(true);
    expect(isEmptyEdit({ vars: { A: "1" }, noBundle: false })).toBe(false);
    expect(isEmptyEdit({ vars: {}, noBundle: true })).toBe(false);
  });
});

describe("the config a deploy packs", () => {
  it("overrides the config's own vars and keeps every other one as written", async () => {
    await writeFile(
      join(project, "wrangler.jsonc"),
      '{ "name": "shop", /* notes */ "vars": { "GREETING": "from-config", "KEPT": "kept" } }',
    );

    const substitute = await editedConfig(project, {
      vars: { GREETING: "from-flag" },
      noBundle: false,
    });

    expect(substitute.name).toBe("wrangler.jsonc");
    expect(JSON.parse(substitute.contents)).toEqual({
      name: "shop",
      vars: { GREETING: "from-flag", KEPT: "kept" },
    });
  });

  it("overrides a config value of any JSON type with the text it was given", async () => {
    await writeFile(
      join(project, "wrangler.jsonc"),
      '{ "name": "shop", "vars": { "RETRIES": 3, "DEBUG": true, "NESTED": { "a": 1 } } }',
    );

    const substitute = await editedConfig(project, {
      vars: { RETRIES: "5", DEBUG: "false" },
      noBundle: false,
    });

    expect(JSON.parse(substitute.contents).vars).toEqual({
      RETRIES: "5",
      DEBUG: "false",
      NESTED: { a: 1 },
    });
  });

  it("writes the variables a config declaring none was never given", async () => {
    await writeFile(join(project, "wrangler.jsonc"), '{ "name": "shop" }');

    const substitute = await editedConfig(project, { vars: { A: "1" }, noBundle: false });

    expect(JSON.parse(substitute.contents)).toEqual({ name: "shop", vars: { A: "1" } });
  });

  it("asserts no_bundle without disturbing anything else the config says", async () => {
    await writeFile(
      join(project, "wrangler.jsonc"),
      '{ "name": "shop", "main": "index.js", "vars": { "A": "1" } }',
    );

    const substitute = await editedConfig(project, { vars: {}, noBundle: true });

    expect(JSON.parse(substitute.contents)).toEqual({
      name: "shop",
      main: "index.js",
      vars: { A: "1" },
      no_bundle: true,
    });
  });

  it("reads wrangler.json when there is no wrangler.jsonc", async () => {
    await writeFile(join(project, "wrangler.json"), '{ "name": "shop" }');

    const substitute = await editedConfig(project, { vars: { A: "1" }, noBundle: false });

    expect(substitute.name).toBe("wrangler.json");
    expect(JSON.parse(substitute.contents)).toEqual({ name: "shop", vars: { A: "1" } });
  });

  it("prefers wrangler.jsonc when the project carries both", async () => {
    await writeFile(join(project, "wrangler.jsonc"), '{ "name": "commented" }');
    await writeFile(join(project, "wrangler.json"), '{ "name": "plain" }');

    const substitute = await editedConfig(project, { vars: { A: "1" }, noBundle: true });

    expect(substitute.name).toBe("wrangler.jsonc");
    expect(JSON.parse(substitute.contents).name).toBe("commented");
  });

  it("refuses a project that carries no config to edit", async () => {
    const error = await rejectsWith(
      () => editedConfig(project, { vars: { A: "1" }, noBundle: false }),
      "invalid-input",
    );

    expect(error.detail).toContain("wrangler.jsonc");
    expect(error.detail).toContain("wrangler.json");
  });

  it("refuses a config whose vars is not an object", async () => {
    await writeFile(join(project, "wrangler.jsonc"), '{ "name": "shop", "vars": ["A=1"] }');

    const error = await rejectsWith(
      () => editedConfig(project, { vars: { A: "1" }, noBundle: false }),
      "invalid-input",
    );

    expect(error.detail).toContain("vars");
  });

  it("refuses a config that is not readable as JSON with comments", async () => {
    await writeFile(join(project, "wrangler.jsonc"), '{ "name": ');

    const error = await rejectsWith(
      () => editedConfig(project, { vars: { A: "1" }, noBundle: false }),
      "invalid-input",
    );

    expect(error.detail).toContain("wrangler.jsonc");
  });

  it("drops a config key every object answers for on its own", async () => {
    await writeFile(
      join(project, "wrangler.jsonc"),
      '{ "name": "shop", "vars": { "__proto__": { "cheat": true }, "A": "1" } }',
    );

    const substitute = await editedConfig(project, { vars: { B: "2" }, noBundle: false });
    const written = JSON.parse(substitute.contents) as { vars: Record<string, unknown> };

    expect(Object.keys(written.vars).sort()).toEqual(["A", "B"]);
    expect(Object.hasOwn(written.vars, "__proto__")).toBe(false);
  });

  it("never writes into the project directory", async () => {
    const original = '{ "name": "shop", "vars": { "A": "1" } }';
    await writeFile(join(project, "wrangler.jsonc"), original);

    await editedConfig(project, { vars: { A: "2" }, noBundle: true });

    await expect(readFile(join(project, "wrangler.jsonc"), "utf8")).resolves.toBe(original);
  });
});
