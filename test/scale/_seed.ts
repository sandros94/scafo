/*
 * A registry at scale, written straight into the store.
 *
 * WRITTEN AS RECORDS, NOT THROUGH THE COMMANDS THAT MAKE THEM. Creating fifty
 * thousand records through the registry's own functions would cost several
 * round trips each and measure nothing: seeding is setup, and every operation
 * it spends is one the meter must not see. Each record below is therefore
 * assembled here and written with one conditional-free put — and
 * `baseline.test.ts` holds every one of them against what the real function
 * writes for the same input, byte for byte, so a record that drifted from the
 * code being measured fails a test rather than quietly changing a number.
 *
 * The few records an installation has one of per MACHINE — the node records —
 * go through `registerNode`, because there are at most fifty of them and the
 * identity reservation it writes is part of what a node is.
 */

import { assignNodes } from "../../src/core/placement/rendezvous.ts";
import { putJson } from "../../src/core/registry/cas.ts";
import type { RegistryContext } from "../../src/core/registry/context.ts";
import { registerNode } from "../../src/core/registry/nodes.ts";
import {
  applicationKey,
  deployKey,
  deploymentKey,
  domainKey,
  placementKey,
  trustKey,
} from "../../src/core/registry/paths.ts";
import type {
  ApplicationRecord,
  DeploymentRecord,
  DeployRecord,
  DomainClaim,
  NodeRecord,
  NodeServing,
  PlacementRecord,
  ReplicaCount,
  TrustPolicy,
} from "../../src/core/types/registry.ts";
import { mapConcurrent } from "../../src/core/utils/concurrency.ts";
import { MIN_CELLD_VERSION } from "../../src/drivers/runtime/celld.ts";

/** The named sizes every scenario is measured at. */
export type ProfileName = "S" | "M" | "L" | "XL";

/** One installation's shape: how much of everything it holds. */
export interface ScaleProfile {
  name: ProfileName;
  /** Applications, prefix siblings included. */
  applications: number;
  nodes: number;
  /** What every application asks for; the fleet-wide default is `"all"`. */
  replicas: ReplicaCount;
  /** Deployment records kept per application. */
  deploymentsKept: number;
  /** Deploy records per application, inside their seven-day retention. */
  deployRecords: number;
  /** Applications carrying an OIDC trust policy. */
  trustPolicies: number;
  /** Custom domains claimed per application; absent is none. */
  domainsPerApplication?: number;
}

/**
 * S is one developer on a VPS; M is an agency, at roughly three hundred deploys
 * a month against a seven-day record retention; L and XL are what an enterprise
 * looks like from the bucket's side. L and XL keep a narrower history than M on
 * purpose: they are there to show what the per-APPLICATION costs do, and the
 * per-deploy-record costs are already visible at M.
 */
export const PROFILES: Record<ProfileName, ScaleProfile> = {
  S: {
    name: "S",
    applications: 5,
    nodes: 1,
    replicas: "all",
    deploymentsKept: 3,
    deployRecords: 5,
    trustPolicies: 5,
    domainsPerApplication: 1,
  },
  M: {
    name: "M",
    applications: 50,
    nodes: 3,
    replicas: "all",
    deploymentsKept: 10,
    deployRecords: 70,
    trustPolicies: 50,
    domainsPerApplication: 1,
  },
  L: {
    name: "L",
    applications: 500,
    nodes: 10,
    replicas: 2,
    deploymentsKept: 10,
    deployRecords: 70,
    trustPolicies: 250,
    domainsPerApplication: 1,
  },
  XL: {
    name: "XL",
    applications: 5000,
    nodes: 50,
    replicas: 2,
    deploymentsKept: 2,
    deployRecords: 2,
    trustPolicies: 500,
  },
};

export const PROFILE_NAMES: readonly ProfileName[] = ["S", "M", "L", "XL"] as const;

/** Platform domain every seeded installation serves its applications under. */
export const PLATFORM_DOMAIN: string = "apps.test";

/** Apex every claimed custom domain of a seeded installation sits under. */
export const CUSTOM_DOMAIN: string = "example.test";

/** First public port a node's processes take; the second of each pair is internal. */
export const PORT_RANGE_START: number = 42_000;

/** What a seeded installation is, and what a scenario addresses it by. */
export interface SeededRegistry {
  profile: ScaleProfile;
  /** Every application name, in the order they were created. */
  applications: string[];
  nodes: string[];
  /** Which nodes serve each application, as the coordinator would decide it. */
  placements: Map<string, string[]>;
  /** What each node's record says it serves. */
  serving: Map<string, NodeServing>;
  /** Objects written. */
  keys: number;
  /** A host under the platform domain that resolves to a served application. */
  platformHost: string;
  /** A claimed custom host, or null when the profile claims none. */
  customHost: string | null;
}

export interface SeedOptions {
  /** The moment everything is stamped with. Defaults to the context's clock. */
  now?: Date;
  /** Writes in flight at once; a real bucket wants this bounded. */
  concurrency?: number;
}

/**
 * Names of `count` applications, including the prefix siblings a listing bug
 * hides behind: `app-1` beside `app-10` and `app-1-preview`, so a prefix that
 * forgot its separator reaches records it was never meant to.
 */
export function applicationNames(count: number): string[] {
  const previews = count < 2 ? 0 : Math.max(1, Math.floor(count / 10));
  const names: string[] = [];
  for (let i = 1; i <= count - previews; i++) names.push(`app-${String(i)}`);
  for (let i = 1; i <= previews; i++) names.push(`app-${String(i)}-preview`);
  return names;
}

/** Ids of `count` nodes, as a fleet names its machines. */
export function nodeIds(count: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) ids.push(`node-${String(i)}`);
  return ids;
}

/** Writes a whole installation of `profile` into `ctx`. */
export async function seedRegistry(
  ctx: RegistryContext,
  profile: ScaleProfile,
  opts?: SeedOptions,
): Promise<SeededRegistry> {
  const now = opts?.now ?? ctx.now?.() ?? new Date();
  const concurrency = opts?.concurrency ?? 32;
  const applications = applicationNames(profile.applications);
  const nodes = nodeIds(profile.nodes);
  const domains = profile.domainsPerApplication ?? 0;

  /* Decided with the placement the coordinator uses, so a seeded installation is
     one the coordinator has nothing left to decide about: an assignment pass
     over it writes nothing, which is what "steady state" means. */
  const placements = new Map<string, string[]>();
  const serving = new Map<string, NodeServing>(nodes.map((id) => [id, {}]));
  const ports = new Map<string, number>(nodes.map((id) => [id, PORT_RANGE_START]));
  for (const name of applications) {
    const placed = await assignNodes({ application: name, nodes, replicas: profile.replicas });
    placements.set(name, placed);
    for (const node of placed) {
      const port = ports.get(node) as number;
      ports.set(node, port + 2);
      (serving.get(node) as NodeServing)[name] = { port };
    }
  }

  let keys = 0;
  const write = async (key: string, value: unknown): Promise<void> => {
    await putJson(ctx, key, value);
    keys++;
  };

  await mapConcurrent(applications, concurrency, async (name, index) => {
    const hosts: string[] = [];
    for (let d = 0; d < domains; d++) hosts.push(customHostOf(name, d));

    await write(
      applicationKey(name),
      applicationRecordOf({
        name,
        createdAt: stamp(now, -index - 1),
        deployedAt: stamp(now, -1),
        revision: profile.deploymentsKept,
        domains: hosts,
        ...(profile.replicas === "all" ? {} : { replicas: profile.replicas }),
      }),
    );
    await write(
      placementKey(name),
      placementRecordOf({
        nodes: placements.get(name) as string[],
        decidedAt: stamp(now, -1),
        fence: 1,
      }),
    );

    for (const host of hosts) {
      await write(domainKey(host), domainClaimOf({ application: name, claimedAt: stamp(now, -1) }));
    }

    for (let d = 0; d < profile.deploymentsKept; d++) {
      const version = versionOf(name, d);
      await write(
        deploymentKey(name, version),
        deploymentRecordOf({ version, createdAt: stamp(now, -(d + 1) * 60) }),
      );
    }

    for (let r = 0; r < profile.deployRecords; r++) {
      const id = `${name}.${hex16(`${name}/deploy/${String(r)}`)}`;
      const at = stamp(now, -(r + 1) * 30);
      await write(
        deployKey(name, id),
        deployRecordOf({
          id,
          application: name,
          node: nodes[r % nodes.length] as string,
          acceptedAt: at,
          updatedAt: at,
          deployment: versionOf(name, r % Math.max(1, profile.deploymentsKept)),
        }),
      );
    }

    if (index < profile.trustPolicies) {
      await write(trustKey(name), trustPolicyOf(name));
    }
  });

  for (const id of nodes) {
    await registerNode(ctx, nodeRecordOf({ id, now, serving: serving.get(id) as NodeServing }));
    keys += 2;
  }

  const firstApplication = applications[0] as string;
  return {
    profile,
    applications,
    nodes,
    placements,
    serving,
    keys,
    platformHost: `${firstApplication}.${PLATFORM_DOMAIN}`,
    customHost: domains === 0 ? null : customHostOf(firstApplication, 0),
  };
}

/* ------------------------------------------------- the records, as they land */

/**
 * An application as its first deploy leaves it: what `createApplication` writes,
 * with the deployment notice `recordRevision` puts on it and the custom domains
 * `claimDomain` adds. Field order is the order those functions leave, because
 * that is what the stored bytes are.
 */
export function applicationRecordOf(input: {
  name: string;
  createdAt: string;
  deployedAt: string;
  revision: number;
  domains: string[];
  replicas?: ReplicaCount;
}): ApplicationRecord {
  return {
    v: 1,
    name: input.name,
    createdAt: input.createdAt,
    deployment: { revision: input.revision, deployedAt: input.deployedAt },
    domains: [...input.domains],
    ...(input.replicas === undefined ? {} : { replicas: input.replicas }),
  };
}

/** A placement as `writePlacement` leaves it. */
export function placementRecordOf(input: {
  nodes: string[];
  decidedAt: string;
  fence: number;
}): PlacementRecord {
  return { v: 1, nodes: [...input.nodes].sort(), decidedAt: input.decidedAt, fence: input.fence };
}

/** A deployment as `createDeployment` leaves it. */
export function deploymentRecordOf(input: {
  version: string;
  createdAt: string;
}): DeploymentRecord {
  return { v: 1, version: input.version, createdAt: input.createdAt };
}

/** A finished deploy: `createDeployRecord`, then the `deployed` transition. */
export function deployRecordOf(input: {
  id: string;
  application: string;
  node: string;
  acceptedAt: string;
  updatedAt: string;
  deployment: string;
}): DeployRecord {
  return {
    v: 1,
    id: input.id,
    application: input.application,
    state: "deployed",
    node: input.node,
    acceptedAt: input.acceptedAt,
    updatedAt: input.updatedAt,
    deployment: input.deployment,
  };
}

/** A claim as `claimDomain` leaves it. */
export function domainClaimOf(input: { application: string; claimedAt: string }): DomainClaim {
  return { v: 1, application: input.application, claimedAt: input.claimedAt };
}

/** One application's OIDC policy, as `setTrustPolicy` stores it. */
export function trustPolicyOf(application: string): TrustPolicy {
  return {
    v: 1,
    issuers: [
      {
        iss: "https://token.actions.githubusercontent.com",
        aud: "scafo",
        subjects: [`repo:acme/${application}:*`],
      },
    ],
  };
}

/** A machine of the fleet, answering now and serving what it was placed. */
export function nodeRecordOf(input: { id: string; now: Date; serving: NodeServing }): NodeRecord {
  const index = Number(input.id.slice("node-".length));
  return {
    v: 1,
    id: input.id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: input.id },
    addresses: { internal: `10.0.0.${String(index)}`, apiPort: 7400 },
    heartbeatAt: input.now.toISOString(),
    versions: { scafo: "0.0.0-scale", celld: MIN_CELLD_VERSION },
    serving: input.serving,
  };
}

/** The host `index` of an application's claimed custom domains. */
export function customHostOf(application: string, index: number): string {
  return `${application}-${String(index)}.${CUSTOM_DOMAIN}`;
}

/** The version of one application's `index`-th kept deployment. */
export function versionOf(application: string, index: number): string {
  return hex16(`${application}/deployment/${String(index)}`);
}

/** `ms` minutes before `at`, as the registry stamps a moment. */
function stamp(at: Date, minutes: number): string {
  return new Date(at.getTime() + minutes * 60_000).toISOString();
}

/**
 * Sixteen lowercase hex characters derived from `seed`: a content id's shape,
 * and the same one for the same seed on every run, so two runs of a profile
 * write identical bytes and their numbers are comparable.
 */
export function hex16(seed: string): string {
  let hex = "";
  for (let round = 0; round < 2; round++) {
    /* FNV-1a, 32 bits, twice over: enough spread for distinct keys, and nothing
       here depends on it being a cryptographic digest. */
    let hash = 0x81_1c_9d_c5;
    for (const unit of `${String(round)}:${seed}`) {
      hash ^= unit.codePointAt(0) as number;
      hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
    }
    hex += hash.toString(16).padStart(8, "0");
  }
  return hex;
}
