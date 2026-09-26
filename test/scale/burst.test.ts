/*
 * What one node does when a whole team pushes at once: `n` deploys of `n`
 * different applications, started together against one node's deploy service at
 * its default bounds, each coming back for a place in the queue the way
 * `scafo deploy` does.
 *
 * THE BUDGET: everybody's deploy lands. Thirty to fifty developers pushing
 * inside one publish is ordinary in an installation this is built for, and every
 * refusal is a red pipeline somebody has to re-run by hand.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPLICATION_QUEUED_TASKS,
  DEFAULT_QUEUED_TASKS,
} from "../../src/daemon/_deploy-scheduler.ts";
import { createScaleWorld, deployBurst } from "./_scenarios.ts";
import { PROFILES } from "./_seed.ts";

describe("a burst of concurrent deploys", () => {
  /* A world of its own per burst: a second burst into the same applications
     would publish versions that already exist, and the extra reads a repeat
     costs are not what a burst is being measured for. */
  it.each([5, 30, 50])(
    "lands every one of %i developers' deploys, with nothing refused",
    async (deploys) => {
      const world = await createScaleWorld(PROFILES.M);
      const outcome = await deployBurst(world, { deploys });

      expect(outcome.accepted).toBe(deploys);
      expect(outcome.deployed).toBe(deploys);
      expect(outcome.refused).toEqual({});

      /* Each deploy is of an application of its own, so nothing contends:
         nothing is refused by a precondition and nothing is retried. */
      expect(outcome.snapshot.conflicts).toBe(0);
      /* Five writes each — the deploy record, its two transitions, the
         deployment, the revision — and not one more for having waited. */
      expect(outcome.snapshot.puts).toBe(deploys * 5);
      expect(outcome.snapshot.dels).toBe(0);
    },
    120_000,
  );

  it("is bounded by what the node may stage at once, not by its queue", async () => {
    /*
     * WITHOUT the waiting, which is what `--no-wait` asks for. The node-wide
     * queue is large enough for the whole team; what it admits at any one
     * moment is the staged-byte bound, because a queued deploy is an artifact
     * on disk. Everyone past that is refused at once, before a byte is read —
     * and with the waiting, every one of them comes back and lands.
     */
    const world = await createScaleWorld(PROFILES.M);
    const outcome = await deployBurst(world, { deploys: 50, wait: false });

    expect(outcome.accepted).toBeGreaterThan(0);
    expect(outcome.accepted).toBeLessThan(50);
    expect(outcome.deployed).toBe(outcome.accepted);
    expect(outcome.refused).toEqual({ "deploy-overloaded": 50 - outcome.accepted });
    expect(outcome.accepted).toBeLessThanOrEqual(DEFAULT_QUEUED_TASKS);
  }, 120_000);

  it("keeps one noisy application from taking more than its share of the queue", async () => {
    /* Every deploy of the burst into ONE application: a pipeline that pushed
         the same repository over and over would otherwise fill the node's queue
         with runs whose output nobody will ever serve. */
    const world = await createScaleWorld(PROFILES.M);
    const outcome = await deployBurst(world, {
      deploys: 20,
      wait: false,
      application: world.seed.applications[0] as string,
    });

    expect(outcome.accepted).toBeLessThanOrEqual(DEFAULT_APPLICATION_QUEUED_TASKS);
    expect(outcome.refused).toEqual({ "deploy-overloaded": 20 - outcome.accepted });
  }, 120_000);
});
