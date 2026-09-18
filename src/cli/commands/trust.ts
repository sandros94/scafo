/*
 * `scafo trust`: which CI issuers may deploy an application, and which of their
 * subjects.
 *
 * This is the operator's half of the workload-deploy path: a CI job holds
 * nothing but its own OIDC token — no operator key, no bucket credential — and
 * what admits it is the policy edited here. Written straight into the bucket the
 * way `scafo operator keygen --register` is, because a trust policy
 * is usually set up before there is a node to ask.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { ScafoError } from "../../core/error.ts";
import type { RegistryContext } from "../../core/registry/context.ts";
import { resolveApplication } from "../_application.ts";
import { createRegistry } from "../_bootstrap.ts";
import {
  DEFAULT_TRUST_AUDIENCE,
  addTrustSubjects,
  formatTrustPolicy,
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

const applicationArgs: ArgsDef = {
  ...bucketArgs,
  name: { type: "string", description: "Application the policy belongs to", required: true },
  env: { type: "string", description: "Address the application <name>-<env> instead" },
};

const setArgs: ArgsDef = {
  ...applicationArgs,
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
    multiple: true,
    required: true,
    valueHint: "pattern",
    description:
      "Subject pattern to trust, * matching any run of characters; repeat the flag for several",
  },
};

const removeArgs: ArgsDef = {
  ...applicationArgs,
  issuer: { type: "string", description: "Issuer URL to stop trusting", required: true },
};

const set: CommandDef = defineCommand({
  meta: {
    name: "set",
    description:
      "State every subject an issuer is trusted for, replacing the ones it had; see add to keep them",
  },
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
  meta: { name: "show", description: "Print the issuers an application trusts" },
  args: applicationArgs,
  async run({ args }): Promise<void> {
    try {
      await runShow(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const add: CommandDef = defineCommand({
  meta: {
    name: "add",
    description: "Trust more subjects of an issuer, keeping the ones it is trusted for already",
  },
  args: setArgs,
  async run({ args }): Promise<void> {
    try {
      await runAdd(args as Record<string, unknown>);
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
  meta: { name: "trust", description: "Manage which CI issuers may deploy an application" },
  subCommands: { set, add, show, remove },
});

async function runSet(flags: Record<string, unknown>): Promise<void> {
  const application = target(flags);
  const iss = required(flags, "issuer");
  const subjects = trustSubjects(flags);

  const policy = await setTrustIssuer(await registryFor(flags), {
    application,
    iss,
    aud: text(flags.audience) ?? DEFAULT_TRUST_AUDIENCE,
    subjects,
  });

  const count = subjects.length;
  console.log(
    `scafo: "${application}" now trusts ${iss} for ${String(count)} ` +
      `subject${count === 1 ? "" : "s"}`,
  );
  console.log(formatTrustPolicy(policy));
}

async function runAdd(flags: Record<string, unknown>): Promise<void> {
  const application = target(flags);
  const iss = required(flags, "issuer");

  const { policy, added } = await addTrustSubjects(await registryFor(flags), {
    application,
    iss,
    aud: text(flags.audience) ?? DEFAULT_TRUST_AUDIENCE,
    subjects: trustSubjects(flags),
  });

  const count = added.length;
  console.log(
    count === 0
      ? `scafo: "${application}" already trusts ${iss} for every subject given; nothing changed`
      : `scafo: "${application}" now also trusts ${iss} for ${String(count)} ` +
          `subject${count === 1 ? "" : "s"}`,
  );
  console.log(formatTrustPolicy(policy));
}

async function runShow(flags: Record<string, unknown>): Promise<void> {
  const application = target(flags);
  const policy = await readTrustPolicy(await registryFor(flags), application);

  const count = policy.issuers.length;
  console.log(`scafo: "${application}" trusts ${String(count)} issuer${count === 1 ? "" : "s"}`);
  console.log(formatTrustPolicy(policy));
}

async function runRemove(flags: Record<string, unknown>): Promise<void> {
  const application = target(flags);
  const iss = required(flags, "issuer");
  const policy = await removeTrustIssuer(await registryFor(flags), application, iss);

  console.log(`scafo: "${application}" no longer trusts ${iss}`);
  console.log(formatTrustPolicy(policy));
}

/**
 * The subjects the flags name: one per `--subject`, whole. Nothing is split —
 * a subject is whatever the issuer minted, commas included.
 */
export function trustSubjects(flags: Record<string, unknown>): string[] {
  const given = Array.isArray(flags.subject) ? (flags.subject as unknown[]) : [];
  return given
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** The application this invocation addresses, `--env` resolved. */
function target(flags: Record<string, unknown>): string {
  return resolveApplication({ name: text(flags.name), env: text(flags.env) });
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
