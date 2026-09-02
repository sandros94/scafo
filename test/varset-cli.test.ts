/*
 * `scafo varset`: reading a variable file, deciding what is secret, reading the key that seals
 * it, and the round trip through the registry that an environment's variables make.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import { loadDaemonConfig } from "../src/daemon/config.ts";
import { decodeVarsetKey, readVarsetKeyFile, VARSET_KEY_BYTES } from "../src/cli/_varset-key.ts";
import {
  formatVarset,
  parseDotenv,
  parsePublicNames,
  setVarset,
  showVarset,
  toPlainVarset,
} from "../src/cli/_varset.ts";
import { createBuild } from "../src/core/registry/builds.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { createEnvironment, getEnvironment } from "../src/core/registry/environments.ts";
import { createProject } from "../src/core/registry/projects.ts";
import { importVarsetKey } from "../src/core/registry/varsets.ts";
import { toBase64Url } from "../src/core/utils/base64.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, rejectsWith } from "./_helpers.ts";

const PROJECT = "shop";
const ENVIRONMENT = "prod";
const BUILD = "1111aaaa";

/** The value every "did a secret leak" check scans for. */
const SECRET_MARKER = "hunter2-do-not-print";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("reading a variable file", () => {
  it("takes one KEY=VALUE per line, skipping blank lines and comments", () => {
    const vars = parseDotenv(
      [
        "# the database",
        "",
        "DATABASE_URL=postgres://db.test/app",
        "   ",
        "  # indented comment",
        "  FEATURE_FLAGS = beta  ",
      ].join("\n"),
      ".env",
    );

    expect(vars).toEqual({
      DATABASE_URL: "postgres://db.test/app",
      FEATURE_FLAGS: "beta",
    });
  });

  it("keeps everything after the first = , quotes and all", () => {
    const vars = parseDotenv(
      ["DSN=postgres://user:p=ss@db.test/app?ssl=true", 'GREETING="hello world"', "EMPTY="].join(
        "\n",
      ),
      ".env",
    );

    /* No unquoting: what an operator wrote is what the process is given, so a
       value is never silently different from the file it came out of. */
    expect(vars).toEqual({
      DSN: "postgres://user:p=ss@db.test/app?ssl=true",
      GREETING: '"hello world"',
      EMPTY: "",
    });
  });

  it("reads a file whichever way its lines end", () => {
    expect(parseDotenv("A=1\r\nB=2\r\n", ".env")).toEqual({ A: "1", B: "2" });
  });

  it("refuses a line that is not a variable rather than guessing at it", async () => {
    const cases: [string, string][] = [
      ["DATABASE_URL", "is not KEY=VALUE"],
      ["export A=1", "usable variable name"],
      ["1A=1", "usable variable name"],
      ["A B=1", "usable variable name"],
      ["A=1\nA=2", "set twice"],
    ];

    for (const [text, expected] of cases) {
      const error = await rejectsWith(
        () => Promise.resolve(parseDotenv(text, "/etc/scafo/app.env")),
        "invalid-input",
      );
      expect(error.detail, text).toContain(expected);
      /* Actionable: which file, which line, and what the dialect is. */
      expect(error.detail, text).toContain("/etc/scafo/app.env:");
    }
  });
});

describe("deciding what is secret", () => {
  it("marks every variable secret unless it was named public", () => {
    const plain = toPlainVarset({ DATABASE_URL: "postgres://db.test", FEATURE_FLAGS: "beta" }, [
      "FEATURE_FLAGS",
    ]);

    expect(plain).toEqual({
      DATABASE_URL: { value: "postgres://db.test", secret: true },
      FEATURE_FLAGS: { value: "beta", secret: false },
    });
  });

  it("reads the public names off the flag, comma-separated or repeated", () => {
    /* The argument parser keeps only the last value of a flag given twice, so a
       list is written the way every other list-valued setting here is. */
    expect(parsePublicNames("FEATURE_FLAGS, PUBLIC_URL")).toEqual(["FEATURE_FLAGS", "PUBLIC_URL"]);
    expect(parsePublicNames(["A,B", "C"])).toEqual(["A", "B", "C"]);
    expect(parsePublicNames(undefined)).toEqual([]);
    expect(parsePublicNames("")).toEqual([]);
  });

  it("defaults to secret when nothing is named public at all", () => {
    const plain = toPlainVarset({ A: "1", B: "2" });

    expect(Object.values(plain).every((entry) => entry.secret)).toBe(true);
  });

  it("refuses to mark a variable that is not in the file public", async () => {
    /* A misspelled --public would otherwise pass silently and leave the variable
       the operator meant to publish sealed, which is only discovered later. */
    const error = await rejectsWith(
      () => Promise.resolve(toPlainVarset({ FEATURE_FLAGS: "beta" }, ["FEATURE_FLAG"])),
      "invalid-input",
    );

    expect(error.detail).toContain("FEATURE_FLAG");
  });
});

describe("reading the key file", () => {
  it("accepts the three forms a 32-byte key arrives in, and reads the same key out of each", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(VARSET_KEY_BYTES));
    const hex = [...raw].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const files = {
      raw,
      "hex": `${hex}\n`,
      "hex-upper": hex.toUpperCase(),
      "b64url": toBase64Url(raw),
      "b64url-padded": `${toBase64Url(raw)}=\n`,
    };

    for (const [name, contents] of Object.entries(files)) {
      const path = await keyFile(name, contents);

      /* Same bytes whichever spelling: an operator who re-encodes the key does
         not lock themselves out of their own varsets. */
      expect([...(await keyBytes(path))], name).toEqual([...raw]);
      await expect(readVarsetKeyFile(path)).resolves.toBeDefined();
    }
  });

  it("refuses anything that is not one of them, naming all three", async () => {
    const cases: Record<string, Uint8Array | string> = {
      "empty": "",
      "short": crypto.getRandomValues(new Uint8Array(31)),
      "long": crypto.getRandomValues(new Uint8Array(64)),
      "prose": "this is not a key, it is a sentence",
      "hex-of-16-bytes": "00112233445566778899aabbccddeeff",
      "b64url-of-31-bytes": toBase64Url(crypto.getRandomValues(new Uint8Array(31))),
    };

    for (const [name, contents] of Object.entries(cases)) {
      const path = await keyFile(name, contents);

      const error = await rejectsWith(() => readVarsetKeyFile(path), "invalid-input");
      expect(error.detail, name).toContain("32 raw bytes");
      expect(error.detail, name).toContain("hex");
      expect(error.detail, name).toContain("base64url");
    }
  });

  it("refuses a file that is not there, rather than serving without variables", async () => {
    const error = await rejectsWith(
      () => readVarsetKeyFile(join(tmpdir(), "scafo-no-such-key-file")),
      "invalid-input",
    );

    expect(error.detail).toContain("could not be opened");
  });

  it("takes the key file from a flag, the environment or the file", async () => {
    const required = {
      SCAFO_S3_ENDPOINT: "http://store.test:9000",
      SCAFO_S3_BUCKET: "registry",
      SCAFO_S3_ACCESS_KEY: "key",
      SCAFO_S3_SECRET_KEY: "secret",
    };
    const configPath = "/etc/scafo/scafo.config.jsonc";
    const readConfig = (path: string): Promise<string | null> =>
      Promise.resolve(path === configPath ? JSON.stringify({ varsets: { keyFile: "/f" } }) : null);

    const fromFlag = await loadDaemonConfig({
      env: { ...required, SCAFO_VARSET_KEY_FILE: "/e" },
      flags: { "varset-key-file": "/k" },
    });
    const fromEnv = await loadDaemonConfig({
      configPath,
      readFile: readConfig,
      env: { ...required, SCAFO_VARSET_KEY_FILE: "/e" },
    });
    const fromFile = await loadDaemonConfig({ configPath, readFile: readConfig, env: required });
    const absent = await loadDaemonConfig({ env: required });

    expect([
      fromFlag.varsets?.keyFile,
      fromEnv.varsets?.keyFile,
      fromFile.varsets?.keyFile,
      absent.varsets,
    ]).toEqual(["/k", "/e", "/f", undefined]);
  });
});

describe("the round trip an environment's variables make", () => {
  it("seals them, stores them and points the environment at what it stored", async () => {
    const world = await seededRegistry();

    const result = await setVarset(world.registry, {
      project: PROJECT,
      env: ENVIRONMENT,
      plain: toPlainVarset({ DATABASE_URL: SECRET_MARKER, FEATURE_FLAGS: "beta" }, [
        "FEATURE_FLAGS",
      ]),
      key: world.key,
    });

    const environment = await getEnvironment(world.registry, PROJECT, ENVIRONMENT);
    expect(environment.varset).toBe(result.id);
    expect(result.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("opens what it sealed, with the key read back out of a file", async () => {
    const world = await seededRegistry();
    const path = await keyFile("round-trip", world.raw);
    await setVarset(world.registry, {
      project: PROJECT,
      env: ENVIRONMENT,
      plain: toPlainVarset({ DATABASE_URL: SECRET_MARKER, FEATURE_FLAGS: "beta" }, [
        "FEATURE_FLAGS",
      ]),
      key: world.key,
    });

    const shown = await showVarset(world.registry, {
      project: PROJECT,
      env: ENVIRONMENT,
      key: await readVarsetKeyFile(path),
    });

    expect(shown.described).toEqual({
      DATABASE_URL: { secret: true },
      FEATURE_FLAGS: { secret: false, value: "beta" },
    });
  });

  it("refuses the wrong key rather than reporting an environment with no variables", async () => {
    const world = await seededRegistry();
    await setVarset(world.registry, {
      project: PROJECT,
      env: ENVIRONMENT,
      plain: toPlainVarset({ A: "1" }),
      key: world.key,
    });

    const other = await importVarsetKey(crypto.getRandomValues(new Uint8Array(VARSET_KEY_BYTES)));

    const error = await rejectsWith(
      () => showVarset(world.registry, { project: PROJECT, env: ENVIRONMENT, key: other }),
      "invalid-varset",
    );

    expect(error.detail).toContain("wrong key");
  });

  it("says so plainly when the environment carries no variables at all", async () => {
    const world = await seededRegistry();

    const error = await rejectsWith(
      () => showVarset(world.registry, { project: PROJECT, env: ENVIRONMENT, key: world.key }),
      "not-found",
    );

    expect(error.detail).toContain(`${PROJECT}/${ENVIRONMENT}`);
  });
});

describe("what `scafo varset show` puts on the terminal", () => {
  it("never prints a secret value, key in hand or not", async () => {
    const world = await seededRegistry();
    await setVarset(world.registry, {
      project: PROJECT,
      env: ENVIRONMENT,
      plain: toPlainVarset({ DATABASE_URL: SECRET_MARKER, API_TOKEN: SECRET_MARKER }, []),
      key: world.key,
    });

    const shown = await showVarset(world.registry, {
      project: PROJECT,
      env: ENVIRONMENT,
      key: world.key,
    });
    const printed = formatVarset(shown.described);

    expect(printed).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(shown)).not.toContain(SECRET_MARKER);
    /* The names are not the secret, and an operator needs them to know what is set. */
    expect(printed.split("\n").sort()).toEqual(["API_TOKEN (secret)", "DATABASE_URL (secret)"]);
  });

  it("prints a public value as it is, so it can be checked at a glance", async () => {
    const world = await seededRegistry();
    await setVarset(world.registry, {
      project: PROJECT,
      env: ENVIRONMENT,
      plain: toPlainVarset({ FEATURE_FLAGS: "beta", TOKEN: SECRET_MARKER }, ["FEATURE_FLAGS"]),
      key: world.key,
    });

    const shown = await showVarset(world.registry, {
      project: PROJECT,
      env: ENVIRONMENT,
      key: world.key,
    });

    expect(formatVarset(shown.described)).toBe("FEATURE_FLAGS=beta\nTOKEN (secret)");
  });
});

interface World {
  registry: RegistryContext;
  key: CryptoKey;
  /** The same key, as its 32 bytes. */
  raw: Uint8Array;
}

/** A registry holding one project, one deployed environment and its build history. */
async function seededRegistry(): Promise<World> {
  const { ctx } = ctxWith(new MemoryCasStore());
  await createProject(ctx, { slug: PROJECT });
  await createEnvironment(ctx, PROJECT, { name: ENVIRONMENT });
  await createBuild(ctx, PROJECT, {
    id: BUILD,
    celldVersionId: `version-${BUILD}`,
  });
  await recordDeployment(ctx, PROJECT, ENVIRONMENT, BUILD);

  const raw = crypto.getRandomValues(new Uint8Array(VARSET_KEY_BYTES));
  return { registry: ctx, key: await importVarsetKey(raw), raw };
}

/** The bytes `decodeVarsetKey` reads out of a file, whatever form it is in. */
async function keyBytes(path: string): Promise<Uint8Array> {
  return decodeVarsetKey(new Uint8Array(await readFile(path)), path);
}

async function keyFile(name: string, contents: Uint8Array | string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scafo-varset-key-"));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, contents);
  return path;
}
