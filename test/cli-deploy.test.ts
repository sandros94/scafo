import { parseArgs, renderUsage } from "citty";
import { describe, expect, it, vi } from "vitest";
import {
  configEditFrom,
  deploy,
  deployMetadataFrom,
  watchDeploy,
} from "../src/cli/commands/deploy.ts";
import type { ProblemDetails } from "../src/core/error.ts";
import type { DeployStatus } from "../src/daemon/deploys.ts";
import { rejectsWith } from "./_helpers.ts";

/** The flags exactly as citty hands them to the command's run. */
function flagsOf(argv: string[]): Record<string, unknown> {
  return parseArgs(argv, deploy.args as never) as Record<string, unknown>;
}

describe("scafo deploy flags", () => {
  it("edits the config only when a flag asks for it", () => {
    expect(configEditFrom(flagsOf(["--project", "app"]))).toEqual({ vars: {}, noBundle: false });
    expect(configEditFrom(flagsOf(["--project", "app", "--no-bundle"]))).toEqual({
      vars: {},
      noBundle: true,
    });
  });

  it("reads every --var it was given, not just the last one", () => {
    expect(
      configEditFrom(flagsOf(["--project", "app", "--var", "A:1", "--var", "B:2"])).vars,
    ).toEqual({ A: "1", B: "2" });
    expect(configEditFrom(flagsOf(["--project", "app", "--var=A:1"])).vars).toEqual({ A: "1" });
  });

  it("splits a --var at its first colon and takes the rest verbatim", () => {
    expect(
      configEditFrom(flagsOf(["--project", "app", "--var", "URL:https://x.test:8080/a,b"])).vars,
    ).toEqual({ URL: "https://x.test:8080/a,b" });
    expect(configEditFrom(flagsOf(["--project", "app", "--var", "EMPTY:"])).vars).toEqual({
      EMPTY: "",
    });
  });

  it("defaults the environment, and carries the placement flags only when named", () => {
    const bare = deployMetadataFrom(flagsOf(["--project", "app"]));
    expect(bare).toEqual({ environment: "production" });

    const placed = deployMetadataFrom(
      flagsOf([
        "--project",
        "app",
        "--env",
        "staging",
        "--replicas",
        "2",
        "--node-selector",
        "tier=fast",
      ]),
    );
    expect(placed).toEqual({
      environment: "staging",
      replicas: 2,
      nodeSelector: { tier: "fast" },
    });
  });

  it("names --var in its help, with what a value written there is visible to", async () => {
    const usage = await renderUsage(deploy);

    expect(usage).toContain("--var");
    expect(usage).toContain("process list");
  });
});

const WATCHED = "https://node.test/v1/deploys/a1b2c3d4";
const ACCEPTED: DeployStatus = { id: "a1b2c3d4", project: "shop", state: "accepted" };

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
