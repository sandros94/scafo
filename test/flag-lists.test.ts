/*
 * A list on the command line is a REPEATED FLAG: every occurrence is one whole
 * value, and nothing is split on commas. These go through the real argument
 * definitions each command declares, because the rule is one the parser has to
 * carry — a flag that is not declared repeatable keeps only its last occurrence,
 * and a reader that splits would cut a value in half.
 */

import { type ArgsDef, type CommandDef, parseArgs, renderUsage } from "citty";
import { describe, expect, it } from "vitest";
import { app } from "../src/cli/commands/app.ts";
import { deploy, deployMetadataFrom } from "../src/cli/commands/deploy.ts";
import { operator } from "../src/cli/commands/operator.ts";
import { remote } from "../src/cli/commands/remote.ts";
import { sail, sailArgs } from "../src/cli/commands/sail.ts";
import { readSelectorFlags } from "../src/cli/_applications.ts";
import { configFlags, flagList } from "../src/cli/_flags.ts";
import { operatorApplications } from "../src/cli/_operators.ts";
import { loadDaemonConfig } from "../src/daemon/config.ts";

const BUCKET_ENV = {
  SCAFO_S3_ENDPOINT: "https://s3.test",
  SCAFO_S3_BUCKET: "registry",
  SCAFO_S3_ACCESS_KEY: "key",
  SCAFO_S3_SECRET_KEY: "secret",
};

/** The flags of a subcommand, exactly as the CLI declares them. */
function argsOf(command: CommandDef, name: string): ArgsDef {
  const found = (command.subCommands as Record<string, CommandDef>)[name];
  return found.args as ArgsDef;
}

/** What `scafo sail` hands the configuration loader for the argv it was given. */
async function sailConfig(argv: string[]): ReturnType<typeof loadDaemonConfig> {
  const parsed = parseArgs(argv, sailArgs) as Record<string, unknown>;
  return loadDaemonConfig({ flags: configFlags(parsed), env: BUCKET_ENV });
}

describe("the node settings scafo sail takes a list of", () => {
  it("serves every --platform-domains it was given", async () => {
    const config = await sailConfig([
      "--platform-domains",
      "apps.test",
      "--platform-domains=edge.example.com",
    ]);

    expect(config.platformDomains).toEqual(["apps.test", "edge.example.com"]);
  });

  it("takes one label per --node-labels", async () => {
    const config = await sailConfig(["--node-labels", "tier=fast", "--node-labels", "gpu=a100"]);

    expect(config.node.labels).toEqual({ tier: "fast", gpu: "a100" });
  });

  it("keeps a comma inside the --celld-env value it was written in", async () => {
    const config = await sailConfig([
      "--celld-env",
      "OTEL_HEADERS=a=1,b=2",
      "--celld-env",
      "RUST_LOG=debug",
    ]);

    expect(config.runtime.celldEnv).toEqual({ OTEL_HEADERS: "a=1,b=2", RUST_LOG: "debug" });
  });

  it("admits both tokens a rotation names, the first one primary", async () => {
    const config = await sailConfig([
      "--ingress-token",
      "new-token",
      "--ingress-token",
      "old,token",
    ]);

    expect(config.ingress?.token).toEqual(["new-token", "old,token"]);
  });

  it("attaches the routers to every --traefik-entrypoints", async () => {
    const config = await sailConfig([
      "--traefik-entrypoints",
      "web",
      "--traefik-entrypoints",
      "websecure",
    ]);

    expect(config.ingress?.entryPoints).toEqual(["web", "websecure"]);
  });

  it("leaves a flag nobody wrote to the environment", async () => {
    const config = await sailConfig(["--listen", "0.0.0.0:7400"]);

    expect(config.platformDomains).toEqual([]);
    expect(config.node.labels).toBeUndefined();
    expect(config.ingress).toBeUndefined();
  });
});

/* Not lists, but the same rule about a flag reaching the loader under the one
   spelling the argument definitions declare. */
describe("what scafo sail is told about certificates", () => {
  it("names the Traefik certificate resolver and the DNS-01 delegation", async () => {
    const config = await sailConfig([
      "--traefik-cert-resolver",
      "letsencrypt",
      "--ingress-acme-delegation",
      "acme.example.com",
    ]);

    expect(config.ingress).toEqual({
      traefikCertResolver: "letsencrypt",
      acmeDelegation: "acme.example.com",
    });
  });
});

describe("the placement a deploy states", () => {
  it("takes one label per --node-selector", () => {
    const parsed = parseArgs(
      ["--name", "shop", "--node-selector", "tier=fast", "--node-selector=region=eu-west-1"],
      deploy.args as ArgsDef,
    ) as Record<string, unknown>;

    expect(deployMetadataFrom(parsed).nodeSelector).toEqual({
      tier: "fast",
      region: "eu-west-1",
    });
  });
});

describe("the nodes scafo app selector chooses", () => {
  it("takes one label per --set", () => {
    const parsed = parseArgs(
      ["--name", "shop", "--set", "tier=fast", "--set=region=eu-west-1"],
      argsOf(app, "selector"),
    ) as Record<string, unknown>;

    expect(readSelectorFlags({ set: flagList(parsed.set), clear: parsed.clear === true })).toEqual({
      tier: "fast",
      region: "eu-west-1",
    });
  });
});

describe("the applications an operator key is scoped to", () => {
  it("takes one entry per --apps, globs and the wildcard included", () => {
    const parsed = parseArgs(
      ["doc", "--apps", "shop", "--apps", "shop-*"],
      argsOf(operator, "enroll"),
    ) as Record<string, unknown>;

    expect(operatorApplications(parsed.apps)).toEqual({ applications: ["shop", "shop-*"] });
  });
});

describe("the endpoints a remote is reached at", () => {
  it("takes one URL per --endpoint, keeping a comma inside one", () => {
    const parsed = parseArgs(
      ["prod", "--endpoint", "http://a:7400", "--endpoint", "http://b:7400/x,y"],
      argsOf(remote, "add"),
    ) as Record<string, unknown>;

    expect(flagList(parsed.endpoint)).toEqual(["http://a:7400", "http://b:7400/x,y"]);
  });
});

describe("what the help says about a repeated flag", () => {
  it("renders the value hint with the repetition mark, and no comma example", async () => {
    const usage = await renderUsage(sail);

    expect(usage).toContain("--platform-domains=<domain>...");
    expect(usage).toContain("--celld-env=<NAME=value>...");
    expect(usage).toContain("repeat the flag for several");
    expect(usage).not.toContain("region=eu-west-1,tier=fast");
  });
});
