import { parseArgs } from "citty";
import { describe, expect, it } from "vitest";
import { deploy, deployMetadataFrom } from "../src/cli/commands/deploy.ts";

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
