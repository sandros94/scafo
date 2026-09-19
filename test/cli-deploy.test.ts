import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, renderUsage } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configEditFrom,
  deploy,
  deployMetadataFrom,
  type QueueWait,
  queueWaitFrom,
  uploadUntilAdmitted,
  watchDeploy,
} from "../src/cli/commands/deploy.ts";
import { DEFAULT_QUEUE_TIMEOUT_MS } from "../src/daemon/_deploy-scheduler.ts";
import { editedConfig, isEmptyEdit } from "../src/cli/_deploy-config.ts";
import { type ProblemDetails, ScafoError } from "../src/core/error.ts";
import type { DeployStatus } from "../src/daemon/deploys.ts";
import { rejectsWith } from "./_helpers.ts";

/** The flags exactly as citty hands them to the command's run. */
function flagsOf(argv: string[]): Record<string, unknown> {
  return parseArgs(argv, deploy.args as never) as Record<string, unknown>;
}

describe("scafo deploy flags", () => {
  it("edits the config only when a flag asks for it", () => {
    expect(configEditFrom(flagsOf(["--name", "app"]))).toEqual({ vars: {}, noBundle: false });
    expect(configEditFrom(flagsOf(["--name", "app", "--no-bundle"]))).toEqual({
      vars: {},
      noBundle: true,
    });
  });

  it("reads every --var it was given, not just the last one", () => {
    expect(configEditFrom(flagsOf(["--var", "A:1", "--var", "B:2"])).vars).toEqual({
      A: "1",
      B: "2",
    });
    expect(configEditFrom(flagsOf(["--var=A:1"])).vars).toEqual({ A: "1" });
  });

  it("splits a --var at its first colon and takes the rest verbatim", () => {
    expect(configEditFrom(flagsOf(["--var", "URL:https://x.test:8080/a,b"])).vars).toEqual({
      URL: "https://x.test:8080/a,b",
    });
    expect(configEditFrom(flagsOf(["--var", "EMPTY:"])).vars).toEqual({ EMPTY: "" });
  });

  it("carries the placement flags only when they were named", () => {
    /* A deploy that names neither must leave whatever the application already
       carries exactly as it is; neither flag can lift a constraint. */
    expect(deployMetadataFrom(flagsOf(["--name", "app"]))).toEqual({});

    const placed = deployMetadataFrom(
      flagsOf(["--name", "app", "--replicas", "2", "--node-selector", "tier=fast"]),
    );

    expect(placed).toEqual({ replicas: 2, nodeSelector: { tier: "fast" } });
  });

  it("names --var in its help, with what a value written there is visible to", async () => {
    const usage = await renderUsage(deploy);

    expect(usage).toContain("--var");
    expect(usage).toContain("process list");
  });
});

describe("the runtime config a deploy packs", () => {
  /* Comments and spacing nothing rewrites, so an archive that carried a
     re-serialized config would be caught by the comparison and not only by a
     parse. */
  const ON_DISK =
    '{\n  // the application celld publishes\n  "name": "shop",\n  "main": "i.js"\n}\n';

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scafo-deploy-pack-"));
    await writeFile(join(dir, "wrangler.jsonc"), ON_DISK);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("packs the file on disk byte for byte when only the application was chosen", async () => {
    for (const argv of [[], ["--name", "other"], ["--name", "other", "--env", "preview"]]) {
      const edit = configEditFrom(flagsOf(argv));

      /* What `scafo deploy` does with an empty edit: nothing is substituted, so
         the archive carries the file as it stands and the config's own name
         reaches celld as written. */
      expect(isEmptyEdit(edit), argv.join(" ")).toBe(true);
    }
    await expect(readFile(join(dir, "wrangler.jsonc"), "utf8")).resolves.toBe(ON_DISK);
  });

  it("substitutes it for --var and --no-bundle, and still never writes the name into it", async () => {
    const edit = configEditFrom(flagsOf(["--name", "other", "--env", "preview", "--var", "A:1"]));
    expect(isEmptyEdit(edit)).toBe(false);

    const substitute = await editedConfig(dir, edit);

    expect(JSON.parse(substitute.contents)).toEqual({
      name: "shop",
      main: "i.js",
      vars: { A: "1" },
    });
    await expect(readFile(join(dir, "wrangler.jsonc"), "utf8")).resolves.toBe(ON_DISK);
  });
});

const WATCHED = "https://node.test/v1/deploys/a1b2c3d4";
const ACCEPTED: DeployStatus = {
  id: "shop.a1b2c3d4a1b2c3d4",
  application: "shop",
  state: "accepted",
};

/** Answers every poll with the node's uniform authentication refusal. */
const refusing: typeof fetch = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        type: "urn:scafo:auth-invalid",
        title: "Authentication failed",
        status: 401,
      } satisfies ProblemDetails),
      { status: 401, headers: { "content-type": "application/problem+json" } },
    ),
  );

/** Answers each poll with the next status, so a watch runs to a settled one. */
function answering(states: DeployStatus[]): typeof fetch {
  const remaining = [...states];
  return () => Promise.resolve(new Response(JSON.stringify(remaining.shift() ?? states.at(-1))));
}

describe("watching a deploy the node already accepted", () => {
  it("blames the spent --token when a poll is refused, not the deploy", async () => {
    /* The node spends the jti of every token it accepts, so the token that
       uploaded the artifact is refused as a replay by the poll that follows.
       Reported as the bare "Authentication failed" the node answered, that reads
       as the deploy having been rejected — and it was not. */
    const error = await rejectsWith(
      () =>
        watchDeploy(WATCHED, () => Promise.resolve("spent"), ACCEPTED, {
          fixedToken: true,
          pollMs: 0,
          fetchFn: refusing,
        }),
      "auth-invalid",
    );

    expect(error.message).toContain("Deploy accepted");
    expect(error.detail).toContain(ACCEPTED.id);
    expect(error.detail).toContain("--token");
    /* The refusal it is built on is kept, so nothing about the cause is lost. */
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("leaves the node's own refusal alone for an operator key, which mints a fresh token", async () => {
    const error = await rejectsWith(
      () =>
        watchDeploy(WATCHED, () => Promise.resolve("minted"), ACCEPTED, {
          pollMs: 0,
          fetchFn: refusing,
        }),
      "auth-invalid",
    );

    expect(error.message).toBe("Authentication failed");
  });

  it("follows a deploy to the deployment it recorded, and names it", async () => {
    let watched: unknown;
    const printed = await printedBy(async () => {
      watched = await watchDeploy(WATCHED, () => Promise.resolve("minted"), ACCEPTED, {
        pollMs: 0,
        fetchFn: answering([
          { ...ACCEPTED, state: "uploading" },
          { ...ACCEPTED, state: "deployed", deployment: "0f0f0f0f" },
        ]),
      });
    });

    expect(watched).toMatchObject({ state: "deployed", deployment: "0f0f0f0f" });
    expect(printed).toContain("scafo: deployment 0f0f0f0f");
  });

  it("fails on a deploy the node reports as failed, and says why", async () => {
    const error = await rejectsWith(
      () =>
        watchDeploy(WATCHED, () => Promise.resolve("minted"), ACCEPTED, {
          pollMs: 0,
          fetchFn: answering([
            { ...ACCEPTED, state: "failed", detail: "celld exited with code 1" },
          ]),
        }),
      /* No code came with it, so nothing says the caller was at fault. */
      "internal",
    );

    expect(error.detail).toBe("celld exited with code 1");
  });

  it("exits with the code the node failed the deploy with, not one of its own", async () => {
    /* A refusal a pipeline acts on: "turn container classes on at that node" is
       not "your input was wrong", and only the code tells them apart. */
    const error = await rejectsWith(
      () =>
        watchDeploy(WATCHED, () => Promise.resolve("minted"), ACCEPTED, {
          pollMs: 0,
          fetchFn: answering([
            {
              ...ACCEPTED,
              state: "failed",
              code: "capability-missing",
              detail: "this node runs no container class",
            },
          ]),
        }),
      "capability-missing",
    );

    expect(error.detail).toBe("this node runs no container class");
  });
});

/** Every line a command put on the terminal while it ran. */
async function printedBy(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    await run();
  } finally {
    log.mockRestore();
  }
  return lines;
}

describe("waiting for a place in the node's deploy queue", () => {
  /** A node that refuses `refusals` times and then takes the deploy. */
  function nodeRefusing(refusals: number, headers?: Record<string, string>) {
    let sent = 0;
    return {
      attempts: (): number => sent,
      send: async (): Promise<Response> => {
        sent++;
        if (sent > refusals) return new Response(`{"id":"shop.1"}`, { status: 202 });
        const asked = headers?.["retry-after"];
        throw new ScafoError(
          "deploy-overloaded",
          "This node has no room",
          asked === undefined ? {} : { retryAfterMs: Number(asked) * 1000 },
        );
      },
    };
  }

  /** A wait whose clock, sleeping and jitter the test owns. */
  function waiting(overrides: Partial<QueueWait> = {}): {
    opts: QueueWait;
    slept: number[];
    lines: string[];
  } {
    const slept: number[] = [];
    const lines: string[] = [];
    let nowMs = 0;
    return {
      slept,
      lines,
      opts: {
        wait: true,
        timeoutMs: 600_000,
        nowMs: () => nowMs,
        sleep: (ms: number): Promise<void> => {
          slept.push(ms);
          nowMs += ms;
          return Promise.resolve();
        },
        /* No randomness: what is measured is the formula, not the draw. */
        jitter: () => 1,
        log: (line: string) => lines.push(line),
        ...overrides,
      },
    };
  }

  it("comes back until it is admitted, and says so once at each end", async () => {
    const node = nodeRefusing(3);
    const { opts, slept, lines } = waiting();

    const response = await uploadUntilAdmitted(node.send, opts);

    expect(response.status).toBe(202);
    expect(node.attempts()).toBe(4);
    /* One second, doubling, capped: the backoff helper's own formula. */
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("queue is full");
    expect(lines[1]).toContain("admitted after waiting 7s");
  });

  it("waits as long as the node asked when the node asked for longer", async () => {
    const node = nodeRefusing(1, { "retry-after": "30" });
    const { opts, slept } = waiting();

    await uploadUntilAdmitted(node.send, opts);

    expect(slept).toEqual([30_000]);
  });

  it("says nothing at all when the first try is taken", async () => {
    const node = nodeRefusing(0);
    const { opts, lines } = waiting();

    await uploadUntilAdmitted(node.send, opts);

    expect(lines).toEqual([]);
  });

  it("gives up rather than waiting past its deadline, with the node's own refusal", async () => {
    const node = nodeRefusing(100);
    const { opts, slept } = waiting({ timeoutMs: 5000 });

    await rejectsWith(() => uploadUntilAdmitted(node.send, opts), "deploy-overloaded");

    /* Never a sleep that would end past the deadline: it stops instead. */
    expect(slept.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(5000);
  });

  it("fails on the first refusal when --no-wait was given", async () => {
    const node = nodeRefusing(100);
    const { opts, slept, lines } = waiting({ wait: false });

    await rejectsWith(() => uploadUntilAdmitted(node.send, opts), "deploy-overloaded");

    expect(node.attempts()).toBe(1);
    expect(slept).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("never waits on a refusal that is not about the queue", async () => {
    const { opts } = waiting();
    let sent = 0;

    await rejectsWith(
      () =>
        uploadUntilAdmitted(() => {
          sent++;
          return Promise.reject(new ScafoError("invalid-input", "no config in the archive"));
        }, opts),
      "invalid-input",
    );

    expect(sent).toBe(1);
  });

  it("reads the flags a caller wrote, and refuses a timeout that is not one", () => {
    expect(queueWaitFrom(flagsOf(["--name", "app"]))).toMatchObject({
      wait: true,
      timeoutMs: DEFAULT_QUEUE_TIMEOUT_MS,
    });
    expect(queueWaitFrom(flagsOf(["--no-wait"]))).toMatchObject({ wait: false });
    expect(queueWaitFrom(flagsOf(["--queue-timeout", "90"]))).toMatchObject({ timeoutMs: 90_000 });
    expect(() => queueWaitFrom(flagsOf(["--queue-timeout", "soon"]))).toThrow("queue timeout");
  });
});
