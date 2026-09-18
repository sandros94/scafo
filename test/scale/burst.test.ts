/*
 * What one node does when a whole team pushes at once: `n` deploys of `n`
 * different applications, started together against one node's deploy service at
 * its default bounds.
 *
 * CHARACTERIZATION, like `baseline.test.ts`: these are today's outcomes, not
 * the wanted ones.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_QUEUED_TASKS } from "../../src/daemon/_deploy-scheduler.ts";
import { createScaleWorld, deployBurst } from "./_scenarios.ts";
import { PROFILES } from "./_seed.ts";

/** Deploys one node takes at once, and what every larger burst is refused down to. */
const ADMITTED = DEFAULT_QUEUED_TASKS;

describe("a burst of concurrent deploys", () => {
  /* A world of its own per burst: a second burst into the same applications
     would publish versions that already exist, and the extra reads a repeat
     costs are not what a burst is being measured for. */
  it.each([5, 30, 50])(
    "admits four and refuses the rest at once, whatever %i developers push",
    async (deploys) => {
      const world = await createScaleWorld(PROFILES.M);
      const outcome = await deployBurst(world, { deploys });

      /* The node-wide queued bound is four, and it is taken before a byte of
         any artifact is read: everyone else is refused immediately. */
      expect(outcome.accepted).toBe(ADMITTED);
      expect(outcome.deployed).toBe(ADMITTED);
      expect(outcome.refused).toEqual({ "deploy-overloaded": deploys - ADMITTED });

      /* One active task at a time, so the four that were taken are published
         one after another; none of them was ever at risk of a deadline here. */
      expect(outcome.snapshot.peakInFlight).toBeLessThanOrEqual(ADMITTED);

      /* Four deploys of four different applications: nothing contends, so
         nothing is refused by a precondition and nothing is retried. */
      expect(outcome.snapshot.conflicts).toBe(0);
      expect(outcome.snapshot.puts).toBe(ADMITTED * 5);
      expect(outcome.snapshot.gets).toBe(ADMITTED * (6 + PROFILES.M.nodes));
      expect(outcome.snapshot.dels).toBe(0);
    },
    120_000,
  );
});
