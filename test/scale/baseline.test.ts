/*
 * What every periodic pass and every hot request is ALLOWED to cost the bucket,
 * as exact formulas of the installation's size.
 *
 * BUDGETS, NOT CHARACTERIZATION. Each number below is what the design commits
 * to, down to the operation, and each assertion names what makes it up. A change
 * that spends more fails here, and so does one that spends less: the new number
 * is written down, deliberately, beside the reason.
 *
 * The principles these hold the code to:
 *   - an idle installation costs the bucket O(nodes), never O(applications) and
 *     never O(history);
 *   - a change is seen by every node within one reconcile interval;
 *   - nothing new is stateful, so a lost change hint costs latency and never
 *     correctness.
 *
 * The scenarios of one profile run in the order they are declared, against one
 * seeded installation, because that is what a node does — it reconciles, it
 * assigns, it reaps, it beats — and because the state a pass leaves is what
 * makes the next one cheap. Each scenario is therefore measured against the
 * state the ones before it left.
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
import { pages } from "./_before.ts";
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

/** Profiles the budgets are held at; L is here while the file stays quick. */
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

/** Every profile under measurement, with its shape, for a table-driven assertion. */
const profiles: Array<[ProfileName, ScaleProfile]> = MEASURED.map((name) => [name, PROFILES[name]]);

describe("one node's reconcile pass in steady state", () => {
  it.each(profiles)("costs one GET at %s, whatever the installation holds", (name) => {
    const { snapshot, notes } = cost(name, "idleReconcilePass");

    /* Nothing is planned and nothing is started: this is the pass a node spends
       almost all of its life running. */
    expect(notes.actions).toBe(0);
    expect(notes.failures).toBe(0);

    /* THE BUDGET: the change hint, and nothing else at all. The token is the one
       the pass before it saw, no timer is up, so the view it already holds is
       the answer. */
    expect(snapshot.gets).toBe(1);
    expect(snapshot.listCalls).toBe(0);
    expect(snapshot.listPages).toBe(0);
    expect(snapshot.puts).toBe(0);
    expect(snapshot.dels).toBe(0);
  });
});

describe("the pass on which the node records come due", () => {
  it.each(profiles)("re-reads liveness and nothing else at %s", (name, profile) => {
    const { snapshot, notes } = cost(name, "nodeRefreshPass");
    expect(notes.failures).toBe(0);

    /* Liveness is the AGE of a heartbeat and no write announces a death, so the
       nodes are the one kind read on a timer rather than on a hint. */
    expect(snapshot.listCalls).toBe(1);
    expect(snapshot.listPages).toBe(pages(profile.nodes));
    /* The hint, then one record per node: in steady state every node has beaten
       since the last look, so every one of them has moved. */
    expect(snapshot.gets).toBe(1 + profile.nodes);
    expect(snapshot.puts).toBe(0);
    expect(snapshot.dels).toBe(0);
  });
});

describe("a full resync with nothing changed", () => {
  it.each(profiles)("costs its listings and not one record at %s", (name, profile) => {
    const { snapshot, notes } = cost(name, "resyncPass");
    expect(notes.failures).toBe(0);

    /* The bound on a hint that never arrived: every kind is listed again
       whatever the token says. Applications, placements, nodes. */
    expect(snapshot.listCalls).toBe(3);
    expect(snapshot.listPages).toBe(2 * pages(profile.applications) + pages(profile.nodes));
    /* The hint, and NOT ONE RECORD: every ETag is the one the view holds. */
    expect(snapshot.gets).toBe(1);
    expect(snapshot.puts).toBe(0);
    expect(snapshot.dels).toBe(0);
  });
});

describe("one deploy, as the node that did not accept it sees it", () => {
  it.each(profiles)("reads the hint, the listings and the one record at %s", (name, profile) => {
    const { snapshot, notes } = cost(name, "peerSeesDeploy");
    expect(notes.state).toBe("deployed");
    expect(notes.failures).toBe(0);

    /* The token moved, so everything routing is decided from is listed: the
       token is opaque, and what a node SERVES is hinted the same way. */
    expect(snapshot.listCalls).toBe(3);
    expect(snapshot.listPages).toBe(2 * pages(profile.applications) + pages(profile.nodes));
    /* The hint, then exactly the records that changed: one application record,
       whose deployment revision moved. */
    expect(snapshot.gets).toBe(2);
    expect(snapshot.puts).toBe(0);
    expect(snapshot.dels).toBe(0);
  });
});

describe("one coordinator tick over an installation nothing has changed in", () => {
  it.each(profiles)("renews the lease and decides nothing at %s", (name) => {
    const { snapshot, notes } = cost(name, "coordinatorAssignPass");

    /* The pass is SKIPPED, not merely quiet: the inputs are the ones the last
       completed pass decided from, and rendezvous hashing over them can only
       reach the same answer. */
    expect(notes.holding).toBe("true");
    expect(notes.skippedAssignments).toBe(1);

    /* THE BUDGET: the change hint, and the lease renewal. Nothing else. */
    expect(snapshot.gets).toBe(1);
    expect(snapshot.puts).toBe(1);
    expect(snapshot.listCalls).toBe(0);
    expect(snapshot.listPages).toBe(0);
    expect(snapshot.dels).toBe(0);
  });
});

describe("one reaper pass with nothing to reap", () => {
  it.each(profiles)("reads the whole history once at %s", (name, profile) => {
    const { snapshot, notes } = cost(name, "reapPass");
    const deploys = profile.applications * profile.deployRecords;

    expect(notes.plannedApplications).toBe(0);
    expect(notes.plannedDeploys).toBe(0);
    expect(notes.plannedStaleDeploys).toBe(0);
    /* No deployment retention is configured by default, so no deployment is
       weighed and none of them is read. */
    expect(notes.plannedDeployments).toBe(0);

    /* ONE listing of every deploy record of the installation, not one per
       application; the applications themselves come from the view the
       coordinator already holds, so they cost nothing. */
    expect(snapshot.listCalls).toBe(1);
    expect(snapshot.listPages).toBe(pages(deploys));
    /* The first sweep reads every record once, because it has seen none of them. */
    expect(snapshot.gets).toBe(deploys);
    expect(snapshot.puts).toBe(0);
    expect(snapshot.dels).toBe(0);
  });

  it.each(profiles)("reads not one record on the sweep after at %s", (name, profile) => {
    const { snapshot, notes } = cost(name, "reapPassAgain");
    const deploys = profile.applications * profile.deployRecords;

    expect(notes.plannedDeploys).toBe(0);
    expect(notes.plannedStaleDeploys).toBe(0);

    /* THE BUDGET: the listing, and nothing else. A deploy that has finished
       never moves again, so its ETag never moves either. */
    expect(snapshot.listCalls).toBe(1);
    expect(snapshot.listPages).toBe(pages(deploys));
    expect(snapshot.gets).toBe(0);
    expect(snapshot.puts).toBe(0);
    expect(snapshot.dels).toBe(0);
  });
});

describe("one heartbeat", () => {
  it.each(profiles)("reads and rewrites one node record at %s", (name) => {
    const { snapshot } = cost(name, "heartbeat");

    /* The read-modify-write of this node's own record, and nothing else. A
       heartbeat is NOT hinted: one every thirty seconds from every node would
       cost the whole fleet a listing several times a minute, forever. */
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

    /* An operator asks rarely and must be shown the truth, so this reads the
       bucket rather than a view — with bounded concurrency rather than one
       record after another. */
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

describe("an idle installation's monthly bill", () => {
  it.each(profiles)("does not grow with the number of applications at %s", (name, profile) => {
    /*
     * THE PRINCIPLE, held as an assertion rather than as prose: what an
     * installation where nobody is deploying costs the bucket is a function of
     * how many MACHINES it has, and of nothing else. Every term below is one of
     * the budgets above.
     */
    const reconcile = cost(name, "idleReconcilePass").snapshot;
    const refresh = cost(name, "nodeRefreshPass").snapshot;
    const resync = cost(name, "resyncPass").snapshot;
    const beat = cost(name, "heartbeat").snapshot;
    const tick = cost(name, "coordinatorAssignPass").snapshot;
    const reap = cost(name, "reapPassAgain").snapshot;

    /* Only the two whole-installation listings are counted per application, and
       they are pages of a thousand keys: at every profile here, one page each. */
    expect(reconcile.requests).toBe(1);
    expect(tick.requests).toBe(2);
    expect(beat.requests).toBe(2);
    expect(refresh.requests).toBe(pages(profile.nodes) + 1 + profile.nodes);
    expect(resync.requests).toBe(1 + 2 * pages(profile.applications) + pages(profile.nodes));
    expect(reap.requests).toBe(pages(profile.applications * profile.deployRecords));
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
