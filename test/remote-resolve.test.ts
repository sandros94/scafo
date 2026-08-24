/*
 * Which remote a command acts on, and which key it signs with.
 *
 * The precedence chain is the whole contract of the redesign: a flag beats the
 * environment, which beats what the project pinned, which beats the single remote
 * a home holds — and an ambiguous home is REFUSED rather than guessed at. The
 * interactive pick is driven through the same seam consola is wired into, so the
 * terminal path is pinned here without a terminal.
 *
 * The last case runs the resolution into the REAL agent app over an injected
 * `fetch`, so what it proves is that a remote-resolved key signs tokens a node
 * actually accepts.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentApp } from "../src/agent/app.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import { agentOps } from "../src/cli/_environments.ts";
import { addRemote, exportRemote } from "../src/cli/_remotes.ts";
import { homeKeyPath } from "../src/cli/_home.ts";
import { operatorSigner } from "../src/cli/_agent.ts";
import {
  INLINE_PREFIX,
  type OperatorKeyFile,
  type PortableOperator,
} from "../src/cli/_operator-key.ts";
import {
  DEFAULT_KEY_PATH,
  resolveOperator,
  SCAFO_OPERATOR_KEY_ENV,
  SCAFO_REMOTE_ENV,
} from "../src/cli/_operator.ts";
import { registerNode } from "../src/core/registry/nodes.ts";
import { createEnvironment, createProject, getEnvironment } from "../src/core/registry/index.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { toBase64 } from "../src/core/utils/base64.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROD_URL = "http://10.0.0.4:7400";
const STAGING_URL = "http://10.0.0.5:7400";

const homes: string[] = [];

afterAll(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
});

describe("which remote a command acts on", () => {
  it("takes the one --remote names, over everything else", async () => {
    const home = await twoFleets();

    const resolved = await resolveOperator({
      home,
      env: { [SCAFO_REMOTE_ENV]: "staging" },
      flags: { remote: "prod" },
      readFile: pinned("staging"),
    });

    expect(resolved.remote).toBe("prod");
    expect(resolved.agentUrl).toBe(PROD_URL);
  });

  it("takes the one SCAFO_REMOTE names when no flag does", async () => {
    const home = await twoFleets();

    const resolved = await resolveOperator({
      home,
      env: { [SCAFO_REMOTE_ENV]: "staging" },
      flags: {},
      readFile: pinned("prod"),
    });

    expect(resolved.remote).toBe("staging");
  });

  it("takes the one the project pinned when neither names one", async () => {
    const home = await twoFleets();

    const resolved = await resolveOperator({
      home,
      env: {},
      flags: {},
      readFile: pinned("staging"),
    });

    /* The pin holds NO SECRET — a name and nothing else — so committing it is
       the point of it. */
    expect(resolved.remote).toBe("staging");
  });

  it("reads the pin out of the file --config names, when one is named", async () => {
    const home = await twoFleets();
    const path = "/etc/scafo/scafo.config.jsonc";

    const resolved = await resolveOperator({
      home,
      env: {},
      flags: { config: path },
      readFile: async (asked) => (asked === path ? `{ "remote": "staging" }` : null),
    });

    expect(resolved.remote).toBe("staging");
  });

  it("uses the only remote there is when nothing names one", async () => {
    const home = await oneFleet();

    const resolved = await resolveOperator({ home, env: {}, flags: {}, readFile: noConfig });

    expect(resolved.remote).toBe("prod");
    expect(resolved.agentUrl).toBe(PROD_URL);
  });

  it("asks on a terminal, and acts on the answer", async () => {
    const home = await twoFleets();
    const asked: string[][] = [];

    const resolved = await resolveOperator({
      home,
      env: {},
      flags: {},
      readFile: noConfig,
      isTTY: true,
      choose: async (names) => {
        asked.push(names);
        return "staging";
      },
    });

    expect(asked).toEqual([["prod", "staging"]]);
    expect(resolved.remote).toBe("staging");
  });

  it("refuses off a terminal, naming every remote and every way to choose one", async () => {
    const home = await twoFleets();

    const error = await rejectsWith(
      () => resolveOperator({ home, env: {}, flags: {}, readFile: noConfig, isTTY: false }),
      "invalid-input",
    );

    /* A command that picked one by itself would deploy to the wrong remote, so
       the refusal has to carry everything needed to pick. */
    expect(error.detail).toContain("prod");
    expect(error.detail).toContain("staging");
    expect(error.detail).toContain("--remote");
    expect(error.detail).toContain(SCAFO_REMOTE_ENV);
    expect(error.detail).toContain("scafo.config.jsonc");
  });

  it("reports a --remote that is not registered rather than inventing one", async () => {
    const home = await twoFleets();

    const error = await rejectsWith(
      () => resolveOperator({ home, env: {}, flags: { remote: "ghost" }, readFile: noConfig }),
      "not-found",
    );

    expect(error.detail).toContain("ghost");
  });

  it("refuses when the home holds nothing at all, naming the command that fills it", async () => {
    const home = await scratch();
    const resolved = await resolveOperator({
      home,
      env: {},
      flags: {},
      readFile: noConfig,
      defaultKeyPath: join(home, "absent.json"),
    });

    /* Refused where a key is actually WANTED: a command that turns out to reach
       the bucket needs none, and must not fail for the want of one. */
    const error = await rejectsWith(() => resolved.readKey(), "invalid-input");

    expect(resolved.agentUrl).toBeUndefined();
    expect(error.detail).toContain("scafo remote add");
  });
});

describe("which key a command signs with", () => {
  it("takes the file --key names, over the environment and the remote", async () => {
    const home = await oneFleet();
    const loose = await looseKeyFile(home, "loose.json");

    const resolved = await resolveOperator({
      home,
      env: { [SCAFO_OPERATOR_KEY_ENV]: await inlinePortable(home, "prod") },
      flags: { key: loose.path },
      readFile: noConfig,
    });

    expect((await resolved.readKey()).id).toBe(loose.key.id);
    /* The remote still says WHERE, because --key only ever said WITH WHAT. */
    expect(resolved.agentUrl).toBe(PROD_URL);
  });

  it("takes SCAFO_OPERATOR_KEY when no flag names one", async () => {
    const home = await oneFleet();
    const other = await scratch();
    const added = await addRemote(other, { name: "elsewhere", endpoints: [STAGING_URL] });

    const resolved = await resolveOperator({
      home,
      env: { [SCAFO_OPERATOR_KEY_ENV]: await inlinePortable(other, "elsewhere") },
      flags: {},
      readFile: noConfig,
    });

    expect((await resolved.readKey()).id).toBe(added.key.id);
  });

  it("falls back to the key the remote carries", async () => {
    const home = await oneFleet();
    const stored = JSON.parse(await readText(homeKeyPath(home, "prod"))) as OperatorKeyFile;

    const resolved = await resolveOperator({ home, env: {}, flags: {}, readFile: noConfig });

    expect((await resolved.readKey()).id).toBe(stored.id);
  });

  it("reads a key file written by scafo operator keygen, byte for byte", async () => {
    const home = await scratch();
    const loose = await looseKeyFile(home, "operator.json");

    const resolved = await resolveOperator({
      home,
      env: {},
      flags: { key: loose.path, agent: PROD_URL },
      readFile: noConfig,
    });

    expect(await resolved.readKey()).toEqual(loose.key);
  });

  it("reads a portable file, and takes the endpoint it carries as the agent", async () => {
    const source = await oneFleet();
    const home = await scratch();
    const path = join(home, "portable.json");
    await writeFile(path, await portableText(source, "prod"), "utf8");

    const resolved = await resolveOperator({
      home,
      env: {},
      flags: { key: path },
      readFile: noConfig,
    });

    /* A bare machine holding one file: it says where to go as well as who to
       be, which is what makes it portable at all. */
    expect(resolved.agentUrl).toBe(PROD_URL);
    expect(resolved.remote).toBe("prod");
  });

  it("reads an inline base64: value the same way", async () => {
    const source = await oneFleet();

    const resolved = await resolveOperator({
      home: await scratch(),
      env: {},
      flags: { key: await inlinePortable(source, "prod") },
      readFile: noConfig,
    });

    expect(resolved.agentUrl).toBe(PROD_URL);
  });

  it("reads anything without the prefix as a path, however much it looks like base64", async () => {
    const home = await scratch();

    const error = await rejectsWith(
      () => resolveOperator({ home, env: {}, flags: { key: "eyJ2IjoxfQ==" }, readFile: noConfig }),
      "invalid-input",
    );

    expect(error.message).toContain("could not be read");
    expect(error.detail).toContain("eyJ2IjoxfQ==");
  });

  it("refuses an inline value that is not base64 at all", async () => {
    const home = await scratch();

    const error = await rejectsWith(
      () =>
        resolveOperator({
          home,
          env: {},
          flags: { key: `${INLINE_PREFIX}!!!` },
          readFile: noConfig,
        }),
      "invalid-input",
    );

    expect(error.detail).toContain(INLINE_PREFIX);
  });

  it("lets --agent override the endpoint the remote carries", async () => {
    const home = await oneFleet();

    const resolved = await resolveOperator({
      home,
      env: {},
      flags: { agent: STAGING_URL },
      readFile: noConfig,
    });

    expect(resolved.agentUrl).toBe(STAGING_URL);
    expect(resolved.remote).toBe("prod");
  });

  it("still finds the key scafo operator keygen left in the working directory, when no remote is registered", async () => {
    const home = await scratch();
    const loose = await looseKeyFile(home, DEFAULT_KEY_PATH);

    const resolved = await resolveOperator({
      home,
      env: {},
      flags: { agent: PROD_URL },
      readFile: noConfig,
      defaultKeyPath: loose.path,
    });

    /* The world before remotes existed: keygen wrote a file here and every
       command found it without being told. */
    expect((await resolved.readKey()).id).toBe(loose.key.id);
  });
});

describe("the resolved remote against a real node", () => {
  let clock: ManualClock;

  beforeEach(() => {
    clock = ctxWith(new MemoryCasStore());
  });

  it("signs a token the node accepts, and the command lands", async () => {
    const home = await oneFleet();
    const resolved = await resolveOperator({ home, env: {}, flags: {}, readFile: noConfig });
    const key = await resolved.readKey();

    /* The public half is what the node verifies against; a key nothing filed is
       a key every request is refused for. */
    await registerNode(clock.ctx, {
      v: 1,
      id: key.id,
      publicKey: { kty: "OKP", crv: "Ed25519", x: key.publicKey.x },
      addresses: { internal: "operator", agentPort: 0 },
    });
    await createProject(clock.ctx, { slug: "app" });
    await createEnvironment(clock.ctx, "app", { name: "prod" });

    const app = createAgentApp({
      config: agentConfig(),
      nodeId: "node-a",
      registry: clock.ctx,
      supervisor: idleSupervisor(),
      version: "0.0.0-test",
    });
    const ops = agentOps({
      url: resolved.agentUrl as string,
      authorize: operatorSigner(key),
      /* The app may answer synchronously; `fetch` never does. */
      fetchFn: async (input, init) => app.request(String(input), init),
    });

    const environment = await ops.retire({ project: "app", env: "prod" });

    expect(environment.retiredAt).toBe(new Date(clock.nowMs()).toISOString());
    expect((await getEnvironment(clock.ctx, "app", "prod")).retiredAt).toBe(environment.retiredAt);
  });
});

/* ------------------------------------------------------------------ helpers */

async function scratch(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "scafo-resolve-"));
  homes.push(home);
  return home;
}

async function oneFleet(): Promise<string> {
  const home = await scratch();
  await addRemote(home, { name: "prod", endpoints: [PROD_URL] });
  return home;
}

async function twoFleets(): Promise<string> {
  const home = await oneFleet();
  await addRemote(home, { name: "staging", endpoints: [STAGING_URL] });
  return home;
}

/** A key file outside the home, exactly as `scafo operator keygen` writes one. */
async function looseKeyFile(
  home: string,
  name: string,
): Promise<{ path: string; key: OperatorKeyFile }> {
  const source = await scratch();
  const added = await addRemote(source, { name: "temp", endpoints: [PROD_URL] });
  const path = join(home, name);
  await writeFile(path, `${JSON.stringify(added.key, null, 2)}\n`, "utf8");
  return { path, key: added.key };
}

async function portableText(home: string, name: string): Promise<string> {
  const lines: string[] = [];
  await exportRemote(home, name, { write: (line) => lines.push(line) });
  return `${lines.join("\n")}\n`;
}

async function inlinePortable(home: string, name: string): Promise<string> {
  const file = JSON.parse(await portableText(home, name)) as PortableOperator;
  return INLINE_PREFIX + toBase64(new TextEncoder().encode(JSON.stringify(file)));
}

async function readText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

/** A project directory that pins a remote by name, and holds nothing else. */
function pinned(name: string): (path: string) => Promise<string | null> {
  return async (path) =>
    path.endsWith("scafo.config.jsonc") ? `{ /* no secrets here */ "remote": "${name}" }` : null;
}

const noConfig = async (): Promise<null> => null;

function agentConfig(): AgentConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: "node-a", listen: "127.0.0.1:7400" },
    platformDomains: ["apps.test"],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      probePath: "/",
      bindHost: "127.0.0.1",
      durability: "bucket",
      cellIdleEvictS: 900,
      pointerHoldMs: 3_000,
    },
    observability: { enabled: false },
    api: { public: true },
  };
}

function idleSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: () => [],
    onExit: () => {},
  };
}
