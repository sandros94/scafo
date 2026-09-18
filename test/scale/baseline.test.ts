/*
 * What every periodic pass and every hot request costs the bucket TODAY, as
 * exact formulas of the installation's size.
 *
 * CHARACTERIZATION, NOT A TARGET. Each number below is what the current code
 * spends, down to the operation, and each assertion names what makes it up. A
 * change that makes a pass cheaper fails these tests, and that failure is the
 * point: the new number is written down, deliberately, beside the reason.
 *
 * The scenarios of one profile run in the order they are declared, against one
 * seeded installation, because that is what a node does — it reconciles, it
 * assigns, it reaps, it beats — and seeding an installation of five thousand
 * applications once per scenario would measure nothing but the seeding. Each
 * scenario is therefore measured against the state the ones before it left.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { recordRevision } from "../../src/core/registry/_revision.ts";
import { createApplication } from "../../src/core/registry/applications.ts";
import { createDeployment } from "../../src/core/registry/deployments.ts";
import { createDeployRecord, updateDeployRecord } from "../../src/core/registry/deploys.ts";
import { claimDomain } from "../../src/core/registry/domains.ts";
import { acquireLease } from "../../src/core/registry/lease.ts";
import {
  applicationKey,
  deployKey,
  deploymentKey,
  domainKey,
  placementKey,
  trustKey,
} from "../../src/core/registry/paths.ts";
import { writePlacement } from "../../src/core/registry/placement.ts";
import { setTrustPolicy } from "../../src/core/registry/trust.ts";
import { MemoryCasStore } from "../../src/drivers/store/memory.ts";
import { LIST_PAGE_KEYS } from "./_meter.ts";
import {
  createScaleWorld,
  runScenario,
  SCALE_NOW,
  SCENARIOS,
  type ScenarioName,
  type ScenarioResult,
} from "./_scenarios.ts";
import {
  applicationRecordOf,
  customHostOf,
  deployRecordOf,
  deploymentRecordOf,
  domainClaimOf,
  placementRecordOf,
  PROFILES,
  trustPolicyOf,
  type ProfileName,
  type ScaleProfile,
} from "./_seed.ts";

/** Profiles the characterization runs at; L is here while the file stays quick. */
const MEASURED: readonly ProfileName[] = ["S", "M", "L"] as const;

/** Every profile's scenarios, measured once and asserted many times. */
const measured = new Map<ProfileName, Map<ScenarioName, ScenarioResult>>();

beforeAll(async () => {
  for (const name of MEASURED) {
    const world = await createScaleWorld(PROFILES[name]);
    const results = new Map<ScenarioName, ScenarioResult>();
    for (const scenario of SCENARIOS) results.set(scenario, await runScenario(scenario, world));
    measured.set(name, results);
  }
}, 120_000);

/** What the profile `name` measured for `scenario`. */
function cost(name: ProfileName, scenario: ScenarioName): ScenarioResult {
  const result = measured.get(name)?.get(scenario);
  if (result === undefined) throw new Error(`"${scenario}" was not measured at ${name}`);
  return result;
}

/** Requests one listing of `keys` keys costs, a thousand keys to the page. */
function pages(keys: number): number {
  return Math.max(1, Math.ceil(keys / LIST_PAGE_KEYS));
}

/** Every profile under measurement, with its shape, for a table-driven assertion. */
const profiles: Array<[ProfileName, ScaleProfile]> = MEASURED.map((name) => [name, PROFILES[name]]);

describe("one node's reconcile pass in steady state", () => {
  it.each(profiles)("costs what reading the desired state costs at %s", (name, profile) => {
    const { snapshot, notes } = cost(name, "idleReconcilePass");
    const applications = profile.applications;

    /* Nothing is planned and nothing is started: this is the pass a node spends
       almost all of its life running. */
    expect(notes.actions).toBe(0);
    expect(notes.failures).toBe(0);

    /* One application record and one placement record each, plus one record per
       node for the fleet's routing. */
    expect(snapshot.gets).toBe(2 * applications + profile.nodes);
    /* The three listings a pass runs: applications, placements, nodes. */
    expect(snapshot.listCalls).toBe(3);
    expect(snapshot.listPages).toBe(
      pages(applications) + pages(applications) + pages(profile.nodes),
    );
    /* A pass that has nothing to do writes nothing at all. */
    expect(snapshot.puts).toBe(0);
    expect(snapshot.dels).toBe(0);
  });
});

describe("one assignment pass of the lease holder", () => {
  it.each(profiles)("re-reads the whole installation to decide nothing at %s", (name, profile) => {
    const { snapshot, notes } = cost(name, "coordinatorAssignPass");
    const applications = profile.applications;

    /* Every application keeps the placement it had: a steady-state pass. */
    expect(notes.changed).toBe(0);
    expect(notes.removed).toBe(0);
    expect(notes.skipped).toBe(applications);
    expect(notes.live).toBe(profile.nodes);

    /* One node record each, then one application record and one placement
       record each. */
    expect(snapshot.gets).toBe(2 * applications + profile.nodes);
    /* Nodes, applications, placements. */
    expect(snapshot.listCalls).toBe(3);
    expect(snapshot.listPages).toBe(
      pages(profile.nodes) + pages(applications) + pages(applications),
    );
    /* An unchanged placement is never rewritten. */
    expect(snapshot.puts).toBe(0);
    expect(snapshot.dels).toBe(0);
  });
});

describe("one reaper pass with nothing to reap", () => {
  it.each(profiles)("reads every deploy record of every application at %s", (name, profile) => {
    const { snapshot, notes } = cost(name, "reapPass");
    const applications = profile.applications;
    /* `oneDeploy` has not run yet at this point in the order, so the history is
       exactly what was seeded. */
    const deploys = applications * profile.deployRecords;

    expect(notes.plannedApplications).toBe(0);
    expect(notes.plannedDeploys).toBe(0);
    expect(notes.plannedStaleDeploys).toBe(0);
    /* No deployment retention is configured by default, so no deployment is
       weighed and none of them is read. */
    expect(notes.plannedDeployments).toBe(0);

    /* One application record each, then EVERY deploy record of every one. */
    expect(snapshot.gets).toBe(applications + deploys);
    /* The applications, then one deploy listing per application. */
    expect(snapshot.listCalls).toBe(1 + applications);
    expect(snapshot.listPages).toBe(
      pages(applications) + applications * pages(profile.deployRecords),
    );
    expect(snapshot.puts).toBe(0);
    expect(snapshot.dels).toBe(0);
  });
});

describe("one heartbeat", () => {
  it.each(profiles)("reads and rewrites one node record at %s", (name) => {
    const { snapshot } = cost(name, "heartbeat");

    /* The read-modify-write of this node's own record, and nothing else. */
    expect(snapshot.gets).toBe(1);
    expect(snapshot.puts).toBe(1);
    expect(snapshot.listCalls).toBe(0);
    expect(snapshot.dels).toBe(0);
  });
});

describe("one accepted deploy", () => {
  it.each(profiles)("costs six reads, the fleet, and five writes at %s", (name, profile) => {
    const { snapshot, notes } = cost(name, "oneDeploy");
    expect(notes.state).toBe("deployed");

    /*
     * The freeze, the application at admission, one record per node for the
     * version-skew gate, then the deploy record twice (uploading, deployed),
     * the deployment the revision names, and the application again.
     */
    expect(snapshot.gets).toBe(6 + profile.nodes);
    /* The deploy record, its two transitions, the deployment, the revision. */
    expect(snapshot.puts).toBe(5);
    /* The node listing behind the version-skew gate. */
    expect(snapshot.listCalls).toBe(1);
    expect(snapshot.listPages).toBe(pages(profile.nodes));
    expect(snapshot.dels).toBe(0);
    expect(snapshot.conflicts).toBe(0);
  });
});

describe("the admin routes", () => {
  it.each(profiles)("read every application record on every listing at %s", (name, profile) => {
    const { snapshot, notes } = cost(name, "listApplicationsRoute");
    expect(notes.status).toBe(200);

    /* The operator record the guard re-reads per request, then one record per
       application. */
    expect(snapshot.gets).toBe(1 + profile.applications);
    expect(snapshot.listCalls).toBe(1);
    expect(snapshot.listPages).toBe(pages(profile.applications));
    expect(snapshot.puts).toBe(0);
  });

  it.each(profiles)("answer the node's own state from two records at %s", (name) => {
    const { snapshot, notes } = cost(name, "stateRoute");
    expect(notes.status).toBe(200);

    /* This node's record and the coordinator lease. The caller's key is already
       cached by the verifier, and this route's guard does not re-read it. */
    expect(snapshot.gets).toBe(2);
    expect(snapshot.listCalls).toBe(0);
    expect(snapshot.puts).toBe(0);
  });
});

describe("what an ingress polls", () => {
  it.each(profiles)("touches the bucket not at all at %s", (name) => {
    const { snapshot, notes } = cost(name, "ingressRoutes");
    expect(notes.status).toBe(200);
    expect(notes.traefikStatus).toBe(200);

    /* Both documents are rendered by the reconcile pass and held in memory, so
       an ingress polling every few seconds costs the bucket nothing. */
    expect(snapshot.requests).toBe(0);
  });

  it.each(profiles)("answers an issuance ask from one or two records at %s", (name) => {
    const { notes } = cost(name, "ingressAsk");

    /* A platform host names its application, so the record answers on its own. */
    expect(notes.platformStatus).toBe(200);
    expect(notes.platformGets).toBe(1);
    /* A claimed domain costs the claim and then the application it names. */
    expect(notes.customStatus).toBe(200);
    expect(notes.customGets).toBe(2);
  });
});

describe("the seeded records", () => {
  /*
   * Seeding writes records rather than calling the functions that make them, so
   * every shape it writes is held here against what the real function stores for
   * the same input — as BYTES, field order included, which is what a reader
   * parses and what a listing weighs.
   */
  const application = "app-1";
  const node = "node-1";
  const version = "abcd1234";
  const at = SCALE_NOW.toISOString();

  it("write what the registry's own functions write", async () => {
    const store = new MemoryCasStore();
    const ctx = { store, now: (): Date => SCALE_NOW };
    const host = customHostOf(application, 0);

    await createApplication(ctx, { name: application });
    await createDeployment(ctx, application, { version });
    await recordRevision(ctx, application, version);
    await claimDomain(ctx, host, application);

    const lease = await acquireLease(ctx, node);
    if (lease === null) throw new Error("the lease could not be taken");
    await writePlacement(ctx, application, [node], lease);

    const id = `${application}.0123456789abcdef`;
    await createDeployRecord(ctx, application, { id, node });
    await updateDeployRecord(ctx, application, id, { state: "deployed", deployment: version });

    await setTrustPolicy(ctx, application, trustPolicyOf(application));

    expect(await bodyOf(store, applicationKey(application))).toBe(
      serialized(
        applicationRecordOf({
          name: application,
          createdAt: at,
          deployedAt: at,
          revision: 1,
          domains: [host],
        }),
      ),
    );
    expect(await bodyOf(store, placementKey(application))).toBe(
      serialized(placementRecordOf({ nodes: [node], decidedAt: at, fence: lease.lease.fence })),
    );
    expect(await bodyOf(store, deploymentKey(application, version))).toBe(
      serialized(deploymentRecordOf({ version, createdAt: at })),
    );
    expect(await bodyOf(store, deployKey(application, id))).toBe(
      serialized(
        deployRecordOf({
          id,
          application,
          node,
          acceptedAt: at,
          updatedAt: at,
          deployment: version,
        }),
      ),
    );
    expect(await bodyOf(store, domainKey(host))).toBe(
      serialized(domainClaimOf({ application, claimedAt: at })),
    );
    expect(await bodyOf(store, trustKey(application))).toBe(serialized(trustPolicyOf(application)));
  });
});

/** The stored text of `key`, which is what a reader and a bill both see. */
async function bodyOf(store: MemoryCasStore, key: string): Promise<string> {
  const found = await store.get(key);
  if (found === null) throw new Error(`"${key}" was never written`);
  return found.body;
}

/** A record as the registry serializes one. */
function serialized(value: unknown): string {
  return JSON.stringify(value, undefined, 2);
}
