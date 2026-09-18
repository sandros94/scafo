/*
 * Applications: the unit scafo deploys, places, serves, blocks, retires and
 * deletes, and everything the registry says about one.
 *
 * There is no create command and no create route. The first deploy creates the
 * application; every setter here refuses a missing one with `not-found`, so a
 * typed name never becomes an empty application nobody asked for.
 */

import { ScafoError } from "../error.ts";
import { assertReplicas } from "../placement/replicas.ts";
import { assertSelector } from "../placement/selector.ts";
import type { ApplicationRecord, NodeSelector, ReplicaCount } from "../types/registry.ts";
import { isSlug } from "../utils/slug.ts";
import { isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, readJson, requireJson, updateJson, type UpdateJsonOptions } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { applicationKey, applicationsPrefix } from "./paths.ts";

/** What a first deploy states about the application it is creating. */
export interface CreateApplicationInput {
  name: string;
  /** How many nodes should serve it; absent runs it on every node that may. */
  replicas?: ReplicaCount;
  /** Which nodes may serve it, by the labels they carry; absent is unconstrained. */
  nodeSelector?: NodeSelector;
}

/**
 * Creates an application, or returns the existing one unchanged.
 *
 * Settings beyond the identity apply on first creation only, so a retried
 * create stays idempotent however the application has been used since. A
 * replica count or a selector that is not one is refused with `invalid-input`.
 */
export async function createApplication(
  ctx: RegistryContext,
  input: CreateApplicationInput,
): Promise<ApplicationRecord> {
  if (input.replicas !== undefined) assertReplicas(input.replicas);
  if (input.nodeSelector !== undefined) assertSelector(input.nodeSelector);

  const key = applicationKey(input.name);
  const record: ApplicationRecord = {
    v: 1,
    name: input.name,
    createdAt: nowIso(ctx),
    deployment: null,
    domains: [],
    ...(input.replicas === undefined ? {} : { replicas: input.replicas }),
    ...(input.nodeSelector === undefined ? {} : { nodeSelector: { ...input.nodeSelector } }),
  };

  try {
    await createJson(ctx, key, record);
    return record;
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    const existing = await requireJson<ApplicationRecord>(ctx, key);
    return existing.value;
  }
}

/** The application, or `ScafoError("not-found")` when there is none. */
export async function getApplication(
  ctx: RegistryContext,
  name: string,
): Promise<ApplicationRecord> {
  const found = await requireJson<ApplicationRecord>(ctx, applicationKey(name));
  return found.value;
}

/** The application record, or null when absent. */
export async function findApplication(
  ctx: RegistryContext,
  name: string,
): Promise<ApplicationRecord | null> {
  const found = await readJson<ApplicationRecord>(ctx, applicationKey(name));
  return found?.value ?? null;
}

/** Whether an existing application is blocked; absent applications are not. */
export async function isApplicationBlocked(ctx: RegistryContext, name: string): Promise<boolean> {
  return (await findApplication(ctx, name))?.blocked === true;
}

/** Throws `application-blocked` for a blocked application; authorization is checked earlier. */
export function assertApplicationUnblocked(application: ApplicationRecord): void {
  if (application.blocked !== true) return;

  throw new ScafoError("application-blocked", "This application is blocked", {
    detail:
      `"${application.name}" has been blocked by an admin of this fleet: it is served nowhere ` +
      `and accepts no deploys until the block is lifted, and nothing of it has been deleted — ` +
      `ask whoever administers this installation`,
  });
}

/** Sets the reversible block flag. */
export async function blockApplication(
  ctx: RegistryContext,
  name: string,
): Promise<ApplicationRecord> {
  return updateApplication(ctx, name, (current) => ({ ...current, blocked: true }));
}

/** Removes the block flag; idempotent. */
export async function unblockApplication(
  ctx: RegistryContext,
  name: string,
): Promise<ApplicationRecord> {
  return updateApplication(ctx, name, ({ blocked: _blocked, ...rest }) => rest);
}

/** Replaces labels wholesale; an empty map removes the field. */
export async function setApplicationLabels(
  ctx: RegistryContext,
  name: string,
  labels: Record<string, string>,
): Promise<ApplicationRecord> {
  const wanted = { ...labels };
  return updateApplication(ctx, name, ({ labels: _labels, ...rest }) =>
    Object.keys(wanted).length === 0 ? rest : { ...rest, labels: wanted },
  );
}

/** Names of every application in the registry, lexicographically sorted. */
export async function listApplications(ctx: RegistryContext): Promise<string[]> {
  const prefix = applicationsPrefix();
  /* One key per application and nothing else beneath the prefix, so this reads no
     deployment and no deploy of anyone. Anything that is not exactly
     "<name>.json" for a name the fleet could have is not a record of ours. */
  const names = namesFromKeys(await ctx.store.list(prefix), prefix).filter((name) => isSlug(name));
  /* Sorted by NAME rather than left in key order: "acme-preview.json" sorts
     before "acme.json" because a hyphen (0x2d) precedes a dot (0x2e). Listing
     them that way would put a table's rows in an order nobody reading it can
     account for. */
  names.sort();
  return names;
}

/** Application records in name order; records deleted after listing are omitted. */
export async function listApplicationRecords(ctx: RegistryContext): Promise<ApplicationRecord[]> {
  const records: ApplicationRecord[] = [];
  for (const name of await listApplications(ctx)) {
    const found = await findApplication(ctx, name);
    if (found !== null) records.push(found);
  }
  return records;
}

/**
 * Read-modify-write of an application. `v` and `name` identify the record and
 * may not be changed; doing so throws `ScafoError("immutable")`.
 *
 * Mutations are functional and preserve the fields they do not own, so a deploy
 * can never drop a block or a fleet's labels.
 */
export async function updateApplication(
  ctx: RegistryContext,
  name: string,
  mutate: (current: ApplicationRecord) => ApplicationRecord | Promise<ApplicationRecord>,
  opts?: UpdateJsonOptions,
): Promise<ApplicationRecord> {
  const updated = await updateJson<ApplicationRecord>(
    ctx,
    applicationKey(name),
    async (current) => {
      const next = await mutate(current);
      if (next.v !== current.v || next.name !== current.name) {
        throw new ScafoError("immutable", "Application identity cannot be changed", {
          detail: `"${name}" must keep v ${String(current.v)} and name "${current.name}"`,
        });
      }
      return next;
    },
    opts,
  );
  return updated.value;
}
