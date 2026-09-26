/* Fault injection proves multi-write flows remain referentially safe and retryable. */

import { describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import {
  acquireLease,
  checkDomain,
  claimDomain,
  createApplication,
  createDeployment,
  executeReap,
  getApplication,
  getDeployment,
  planReap,
  retireApplication,
  type ReapOptions,
} from "../src/core/registry/index.ts";
import { fleetPrefix } from "../src/core/registry/paths.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import {
  ctxWith,
  FaultStore,
  type InvariantOptions,
  invariants,
  type ManualClock,
  rejectsWith,
} from "./_helpers.ts";

const APPLICATION = "app";
const VERSION = "0f0f0f0f";
const HOST = "flow.example.com";
const HOUR_MS = 3_600_000;

interface Flow {
  name: string;
  /** Fault-free setup, replayed on a fresh store before every kill. */
  seed: (clock: ManualClock) => Promise<void>;
  /** The scripted flow under test; it is what gets killed. */
  run: (clock: ManualClock) => Promise<void>;
  /** Asserted once the flow has been re-run without faults. */
  settled: (clock: ManualClock) => Promise<void>;
  invariantOptions?: InvariantOptions;
}

const REAP_OPTIONS: ReapOptions = { deploymentRetention: { maxAgeMs: HOUR_MS } };

const FLOWS: Flow[] = [
  {
    name: "createDeployment then recordRevision",
    seed: async ({ ctx }) => {
      await createApplication(ctx, { name: APPLICATION });
    },
    run: async ({ ctx }) => {
      await createDeployment(ctx, APPLICATION, { version: VERSION });
      await recordRevision(ctx, APPLICATION, VERSION);
    },
    settled: async ({ ctx }) => {
      await expect(getDeployment(ctx, APPLICATION, VERSION)).resolves.toMatchObject({
        version: VERSION,
      });
      await expect(getApplication(ctx, APPLICATION)).resolves.toMatchObject({
        deployment: { revision: 1 },
      });
    },
  },
  {
    name: "claimDomain",
    seed: async ({ ctx }) => {
      await createApplication(ctx, { name: APPLICATION });
    },
    run: async ({ ctx }) => {
      await claimDomain(ctx, HOST, APPLICATION);
    },
    settled: async ({ ctx }) => {
      await expect(checkDomain(ctx, HOST)).resolves.toMatchObject({ application: APPLICATION });
      await expect(getApplication(ctx, APPLICATION)).resolves.toMatchObject({ domains: [HOST] });
    },
  },
  {
    name: "executeReap of an application with a domain and fleet keys",
    seed: async (clock) => {
      await createApplication(clock.ctx, { name: APPLICATION });
      await claimDomain(clock.ctx, HOST, APPLICATION);
      await retireApplication(clock.ctx, APPLICATION);
      for (const suffix of ["node-a.json", "state/routes.json"]) {
        await clock.ctx.store.put(`${fleetPrefix(APPLICATION)}/${suffix}`, "{}");
      }
      clock.tick(86_400_001);
    },
    run: async ({ ctx }) => {
      const lease = await acquireLease(ctx, "node-a");
      if (lease === null) throw new Error("the reap flow could not take the lease");
      const plan = await planReap(ctx, REAP_OPTIONS);
      await executeReap(ctx, plan, lease, REAP_OPTIONS);
    },
    settled: async ({ ctx }) => {
      await rejectsWith(() => getApplication(ctx, APPLICATION), "not-found");
    },
  },
];

/** Counts the write ops the flow performs when nothing is in its way. */
async function writesOf(flow: Flow): Promise<number> {
  const store = new FaultStore(new MemoryCasStore());
  const clock = ctxWith(store);
  await flow.seed(clock);

  const before = store.puts + store.dels;
  await flow.run(clock);
  return store.puts + store.dels - before;
}

describe.each(FLOWS)("$name", (flow) => {
  it("survives being killed at every one of its writes", async () => {
    const writes = await writesOf(flow);
    expect(writes).toBeGreaterThan(0);

    /* k is the write that gets killed, so every write of the flow takes a turn. */
    let killed = 0;
    for (let k = 0; k < writes; k++) {
      const store = new FaultStore(new MemoryCasStore());
      const clock = ctxWith(store);
      await flow.seed(clock);

      store.failAfter(k);
      const outcome = await flow.run(clock).then(
        () => "completed",
        () => "killed",
      );
      store.clearFaults();
      if (outcome === "killed") killed++;

      /* Whatever the kill left behind is a state the registry must be able to hold. */
      await invariants(store, flow.invariantOptions);

      await flow.run(clock);
      await invariants(store, flow.invariantOptions);
      await flow.settled(clock);
    }

    expect(killed, "every write should have been killable").toBe(writes);
  });
});
