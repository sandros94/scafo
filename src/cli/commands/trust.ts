/*
 * `scafo trust`: which CI issuers may deploy a project, and which of their
 * subjects.
 *
 * This is the operator's half of the workload-deploy path: a CI job holds
 * nothing but its own OIDC token — no operator key, no bucket credential — and
 * what admits it is the policy edited here. Written straight into the bucket the
 * way `scafo operator keygen --register` and `scafo varset` are, because a trust policy
 * is usually set up before there is a node to ask.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { ScafoError } from "../../core/error.ts";
import type { RegistryContext } from "../../core/registry/context.ts";
import { createRegistry } from "../_bootstrap.ts";
import {
  DEFAULT_TRUST_AUDIENCE,
  formatTrustPolicy,
  parseSubjects,
  readTrustPolicy,
  removeTrustIssuer,
  setTrustIssuer,
} from "../_trust.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

/* The bucket the registry lives in, exactly as `scafo sail` takes it. */
const bucketArgs: ArgsDef = {
  "config": { type: "string", description: "Path to scafo.config.jsonc" },
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
};

const projectArgs: ArgsDef = {
  ...bucketArgs,
  project: { type: "string", description: "Project the policy belongs to", required: true },
};

const setArgs: ArgsDef = {
  ...projectArgs,
  issuer: {
    type: "string",
    description: "Issuer URL, as its tokens carry it in iss",
    required: true,
  },
  audience: {
    type: "string",
    description: `Audience the workload requests its token for (${DEFAULT_TRUST_AUDIENCE})`,
  },
  subject: {
    type: "string",
    description:
      "Subject pattern to trust, * matching any run of characters; comma-separated for several",
    required: true,
  },
};

const removeArgs: ArgsDef = {
  ...projectArgs,
  issuer: { type: "string", description: "Issuer URL to stop trusting", required: true },
};

const set: CommandDef = defineCommand({
  meta: { name: "set", description: "Trust an issuer's subjects to deploy a project" },
  args: setArgs,
  async run({ args }): Promise<void> {
    try {
      await runSet(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const show: CommandDef = defineCommand({
  meta: { name: "show", description: "Print the issuers a project trusts" },
  args: projectArgs,
  async run({ args }): Promise<void> {
    try {
      await runShow(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const remove: CommandDef = defineCommand({
  meta: { name: "remove", description: "Stop trusting an issuer" },
  args: removeArgs,
  async run({ args }): Promise<void> {
    try {
      await runRemove(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

export const trust: CommandDef = defineCommand({
  meta: { name: "trust", description: "Manage which CI issuers may deploy a project" },
  subCommands: { set, show, remove },
});

async function runSet(flags: Record<string, unknown>): Promise<void> {
  const project = required(flags, "project");
  const iss = required(flags, "issuer");
  const subjects = parseSubjects(flags.subject);

  const policy = await setTrustIssuer(await registryFor(flags), {
    project,
    iss,
    aud: text(flags.audience) ?? DEFAULT_TRUST_AUDIENCE,
    subjects,
  });

  const count = subjects.length;
  console.log(
    `scafo: "${project}" now trusts ${iss} for ${String(count)} ` +
      `subject${count === 1 ? "" : "s"}`,
  );
  console.log(formatTrustPolicy(policy));
}

async function runShow(flags: Record<string, unknown>): Promise<void> {
  const project = required(flags, "project");
  const policy = await readTrustPolicy(await registryFor(flags), project);

  const count = policy.issuers.length;
  console.log(`scafo: "${project}" trusts ${String(count)} issuer${count === 1 ? "" : "s"}`);
  console.log(formatTrustPolicy(policy));
}

async function runRemove(flags: Record<string, unknown>): Promise<void> {
  const project = required(flags, "project");
  const iss = required(flags, "issuer");
  const policy = await removeTrustIssuer(await registryFor(flags), project, iss);

  console.log(`scafo: "${project}" no longer trusts ${iss}`);
  console.log(formatTrustPolicy(policy));
}

async function registryFor(flags: Record<string, unknown>): Promise<RegistryContext> {
  const config = await loadDaemonConfig({
    configPath: text(flags.config),
    flags: stringFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });
  return createRegistry(config);
}

function required(flags: Record<string, unknown>, name: string): string {
  const value = text(flags[name]);
  if (value !== undefined) return value;

  throw new ScafoError("invalid-input", "Missing required argument", {
    detail: `--${name} must be given`,
  });
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The declared flags that were actually given; anything else the parser adds is not configuration. */
function stringFlags(flags: Record<string, unknown>): Record<string, string | undefined> {
  const given: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (typeof value === "string") given[name] = value;
  }
  return given;
}
