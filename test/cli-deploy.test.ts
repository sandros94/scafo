import { parseArgs } from "citty";
import { describe, expect, it, vi } from "vitest";
import { deploy, deployMetadataFrom, watchDeploy } from "../src/cli/commands/deploy.ts";
import type { ProblemDetails } from "../src/core/error.ts";
import type { DeployStatus } from "../src/daemon/deploys.ts";
import { rejectsWith } from "./_helpers.ts";

/** The flags exactly as citty hands them to the command's run. */
function flagsOf(argv: string[]): Record<string, unknown> {
  return parseArgs(argv, deploy.args as never) as Record<string, unknown>;
}

describe("scafo deploy flags", () => {
  it("asks the node for a pre-bundled entry only under --no-bundle", () => {
    const bundled = deployMetadataFrom(flagsOf(["--project", "app"]), "app");
    expect(bundled).not.toHaveProperty("noBundle");

    const raw = deployMetadataFrom(flagsOf(["--project", "app", "--no-bundle"]), "app");
    expect(raw).toMatchObject({ noBundle: true });
  });

  it("defaults the environment and script, and carries the placement flags only when named", () => {
    const bare = deployMetadataFrom(flagsOf(["--project", "app"]), "app");
    expect(bare).toEqual({ environment: "production", script: "app" });

    const placed = deployMetadataFrom(
      flagsOf([
        "--project",
        "app",
        "--env",
        "staging",
        "--script",
        "worker",
        "--replicas",
        "2",
        "--node-selector",
        "tier=fast",
      ]),
      "app",
    );
    expect(placed).toEqual({
      environment: "staging",
      script: "worker",
      replicas: 2,
      nodeSelector: { tier: "fast" },
    });
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

  it("follows a deploy to the deployment it recorded", async () => {
    const watched = await watchDeploy(WATCHED, () => Promise.resolve("minted"), ACCEPTED, {
      pollMs: 0,
      fetchFn: answering([
        { ...ACCEPTED, state: "uploading" },
        { ...ACCEPTED, state: "deployed", deployment: "0f0f0f0f" },
      ]),
    });

    expect(watched).toMatchObject({ state: "deployed", deployment: "0f0f0f0f" });
  });

  it("says which varset the deploy carried and what it held, and nothing at all when it carried none", async () => {
    const carried = await printedBy(() =>
      watchDeploy(WATCHED, () => Promise.resolve("minted"), ACCEPTED, {
        pollMs: 0,
        fetchFn: answering([
          {
            ...ACCEPTED,
            state: "deployed",
            deployment: "0f0f0f0f",
            varset: { name: "shared", hash: "0123456789abcdef0123456789abcdef" },
          },
        ]),
      }),
    );

    expect(carried).toContain("scafo: deployment 0f0f0f0f");
    expect(carried).toContain('scafo: carried varset "shared" (0123456789ab)');

    const bare = await printedBy(() =>
      watchDeploy(WATCHED, () => Promise.resolve("minted"), ACCEPTED, {
        pollMs: 0,
        fetchFn: answering([{ ...ACCEPTED, state: "deployed", deployment: "0f0f0f0f" }]),
      }),
    );

    expect(bare.join("\n")).not.toContain("varset");
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
