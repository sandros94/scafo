/*
 * The pure reconcile planner: what this node must do to serve what the registry
 * wants, and the order it must do it in.
 *
 * TWO properties every case here defends.
 *
 * The platform's zero-downtime guarantee: a process that still serves an
 * environment is never planned for a stop until EVERY build that environment is
 * wanted at has a process that has passed its readiness gate. A flip that
 * stopped the old process first would drop every request the new one cannot
 * answer yet; a split that retired the outgoing build before its incoming leg
 * was ready would do the same to that leg's share.
 *
 * And the pairing the fleet pointer forces: one pointer per environment, read
 * once per process at startup, so an environment serving several builds must
 * have each of them activated and started as ONE step. The planner says that by
 * emitting one `rollout` per build rather than a phase of activations and a
 * phase of starts — a distinction with no visible consequence for a single-build
 * environment and a total one for a split, where the phased plan would start
 * every process against the last activation and run one build twice.
 *
 * Planning is pure, so nothing here touches a store, a supervisor or a clock:
 * the port pairs are handed in by a counting stand-in, which also makes "how
 * often was the allocator asked" an observable of the plan.
 */

import { describe, expect, it } from "vitest";
import { formatProcessId } from "../src/core/placement/ids.ts";
import {
  type DesiredEnvironment,
  planReconcile,
  type PortView,
  type ReconcileAction,
  type ReconcileInput,
} from "../src/core/placement/reconcile.ts";
import type { BuildRecord, SplitEntry } from "../src/core/types/registry.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";
import { seededRng } from "./_helpers.ts";

/** First public port the stand-in allocator hands out. */
const PORT_START = 42_000;

/** Loopback ports of a process this node already runs; outside the range above. */
const RUNNING_PORT = 43_000;

/** Build ids are lowercase hex, and these three sort in the order they are named. */
const BUILD_ONE = "1111aaaa";
const BUILD_TWO = "2222bbbb";
const BUILD_THREE = "3333cccc";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const FLIPPED_AT = "2026-01-02T00:00:00.000Z";

describe("an environment with nothing running for it", () => {
  it("rolls the build out on an allocated pair, as one action", () => {
    const ports = countingPorts();

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE)],
      actual: [],
      ports,
    });

    /* One action, not three. Pointing the fleet at the build, starting the
       process that loads it and gating that process are inseparable. */
    expect(plan).toEqual([
      {
        type: "rollout",
        project: "shop",
        env: "prod",
        build: BUILD_ONE,
        ports: { public: PORT_START, internal: PORT_START + 1 },
      },
    ]);
    expect(stops(plan)).toEqual([]);
    expect(ports.calls).toBe(1);
  });

  it("names the three parts the process will be identified by", () => {
    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE)],
      actual: [],
      ports: countingPorts(),
    });

    const rollout = plan[0] as Extract<ReconcileAction, { type: "rollout" }>;
    expect(formatProcessId(rollout)).toBe(`shop--prod--${BUILD_ONE}`);
  });
});

describe("a replacement that has not proven itself yet", () => {
  it("gates the new process and leaves the one still serving the environment alone", () => {
    const older = mkProcess("shop", "prod", BUILD_ONE, { ready: true });
    const newer = mkProcess("shop", "prod", BUILD_TWO, { ready: false });
    const ports = countingPorts();

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_TWO)],
      actual: [older, newer],
      ports,
    });

    expect(plan).toEqual([{ type: "await-ready", processId: newer.processId }]);
    /* The whole guarantee in one assertion: the process answering requests today
       is in no stop action while its replacement is unproven. */
    expect(stoppedIds(plan)).not.toContain(older.processId);
    expect(stops(plan)).toEqual([]);
    /* Nothing is started, so nothing is allocated. */
    expect(ports.calls).toBe(0);
  });

  it("gates every process of the wanted build when none of them is ready", () => {
    const first = mkProcess("shop", "prod", BUILD_TWO, { ready: false });
    const retried = mkProcess("shop", "prod", BUILD_TWO, { ready: false, retry: 1 });

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_TWO)],
      actual: [retried, first],
      ports: countingPorts(),
    });

    /* Gates come back in process-id order, not in the order the caller listed
       the processes in. */
    expect(plan).toEqual([
      { type: "await-ready", processId: first.processId },
      { type: "await-ready", processId: retried.processId },
    ]);
  });
});

describe("a replacement that has passed its gate", () => {
  it("retires every superseded process, naming the build that won", () => {
    const first = mkProcess("shop", "prod", BUILD_ONE, { ready: true });
    const second = mkProcess("shop", "prod", BUILD_TWO, { ready: false });
    const winner = mkProcess("shop", "prod", BUILD_THREE, { ready: true });
    const ports = countingPorts();

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_THREE)],
      actual: [winner, second, first],
      ports,
    });

    expect(plan).toEqual([
      { type: "stop", processId: first.processId, reason: `superseded by build "${BUILD_THREE}"` },
      { type: "stop", processId: second.processId, reason: `superseded by build "${BUILD_THREE}"` },
    ]);
    /* The environment is already served by the build it should be: there is
       nothing left to load and nothing left to start. */
    expect(rollouts(plan)).toEqual([]);
    expect(ports.calls).toBe(0);
  });

  it("retires the newer build when the alias has been moved back to an older one", () => {
    /* A rollback is the same shape as a flip, seen from the other side: the
       build the alias names is already running and ready, and the build that was
       serving until a moment ago is now the superseded one. */
    const rolledBackTo = mkProcess("shop", "prod", BUILD_ONE, { ready: true });
    const newer = mkProcess("shop", "prod", BUILD_TWO, { ready: true });

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE)],
      actual: [rolledBackTo, newer],
      ports: countingPorts(),
    });

    expect(plan).toEqual([
      { type: "stop", processId: newer.processId, reason: `superseded by build "${BUILD_ONE}"` },
    ]);
    /*
     * Nothing is rolled out, because both builds already run.
     *
     * A rollback therefore plans no activation, and the fleet's deployment
     * pointer keeps naming the build that was rolled back FROM for as long as a
     * process of the aliased build survives. Nothing loads the abandoned build
     * from it: an activation is inside every rollout, so the pointer is
     * corrected before the next process reads it.
     */
    expect(rollouts(plan)).toEqual([]);
  });

  it("points the fleet at the build it was rolled back to before starting a replacement", () => {
    /* The pointer left behind above, corrected the moment the environment has
       nothing serving it: a start is never planned without the activation that
       decides what that process will load, because they are one action. */
    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE)],
      actual: [],
      ports: countingPorts(),
    });

    expect(plan[0]).toMatchObject({ type: "rollout", build: BUILD_ONE });
  });
});

describe("an environment serving several builds at once", () => {
  it("rolls each leg out on its own, alias first and the split in registry order", () => {
    const ports = countingPorts();

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_TWO, { legs: [BUILD_THREE, BUILD_ONE] })],
      actual: [],
      ports,
    });

    /*
     * THE CASE THE ACTION SHAPE EXISTS FOR. Three rollouts, each carrying its
     * own build and its own port pair, and the executor takes each to its end
     * before starting the next. A plan phased as "activate two, activate three,
     * activate one, then start three processes" would leave the fleet pointer at
     * the last activation, and all three processes would load that one build.
     */
    expect(plan).toEqual([
      {
        type: "rollout",
        project: "shop",
        env: "prod",
        build: BUILD_TWO,
        ports: { public: PORT_START, internal: PORT_START + 1 },
      },
      {
        type: "rollout",
        project: "shop",
        env: "prod",
        build: BUILD_THREE,
        ports: { public: PORT_START + 2, internal: PORT_START + 3 },
      },
      {
        type: "rollout",
        project: "shop",
        env: "prod",
        build: BUILD_ONE,
        ports: { public: PORT_START + 4, internal: PORT_START + 5 },
      },
    ]);
    /* Registry order, NOT sorted order: two, three, one is what was written. */
    expect(builtBy(plan)).toEqual([BUILD_TWO, BUILD_THREE, BUILD_ONE]);
    expect(ports.calls).toBe(3);
  });

  it("counts the alias and a split leg naming it as one build", () => {
    const ports = countingPorts();

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE, { legs: [BUILD_ONE, BUILD_TWO] })],
      actual: [],
      ports,
    });

    /* An alias that is itself a leg is one build and one process, whichever of
       the two roles put it there. */
    expect(builtBy(plan)).toEqual([BUILD_ONE, BUILD_TWO]);
    expect(ports.calls).toBe(2);
  });

  it("re-pairs the activation of a leg that crashed, leaving the surviving one alone", () => {
    /* The pointer may name either leg by now — whichever was rolled out last —
       so restarting the one that died goes through the same paired action a
       first start does, rather than assuming the pointer still fits. */
    const survivor = mkProcess("shop", "prod", BUILD_ONE, { ready: true });

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE, { legs: [BUILD_TWO] })],
      actual: [survivor],
      ports: countingPorts(),
    });

    expect(plan).toEqual([
      {
        type: "rollout",
        project: "shop",
        env: "prod",
        build: BUILD_TWO,
        ports: { public: PORT_START, internal: PORT_START + 1 },
      },
    ]);
    /* And nothing is stopped: the surviving leg is serving, and the one being
       restarted is not proven yet. */
    expect(stops(plan)).toEqual([]);
  });

  it("stops nothing until EVERY leg has a ready process", () => {
    const outgoing = mkProcess("shop", "prod", BUILD_THREE, { ready: true });
    const first = mkProcess("shop", "prod", BUILD_ONE, { ready: true });
    const second = mkProcess("shop", "prod", BUILD_TWO, { ready: false });

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE, { legs: [BUILD_TWO] })],
      actual: [outgoing, first, second],
      ports: countingPorts(),
    });

    /* The 90 is up, the 10 is not, and the build being replaced keeps running:
       retiring it now would hand the unproven leg's share to nothing. */
    expect(plan).toEqual([{ type: "await-ready", processId: second.processId }]);
    expect(stoppedIds(plan)).not.toContain(outgoing.processId);
  });

  it("retires what is not a leg once every leg is ready, naming all of them", () => {
    const outgoing = mkProcess("shop", "prod", BUILD_THREE, { ready: true });
    const first = mkProcess("shop", "prod", BUILD_ONE, { ready: true });
    const second = mkProcess("shop", "prod", BUILD_TWO, { ready: true });

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE, { legs: [BUILD_TWO] })],
      actual: [outgoing, first, second],
      ports: countingPorts(),
    });

    expect(plan).toEqual([
      {
        type: "stop",
        processId: outgoing.processId,
        reason: `superseded by builds "${BUILD_ONE}", "${BUILD_TWO}"`,
      },
    ]);
  });

  it("stops the legs a cleared split dropped, once the alias is ready", () => {
    /* `scafo env split --clear`, seen one pass later: the environment is wanted
       at its alias alone again, and the leg that was taking 10% is retired — but
       only because the alias is up, which it has been all along. */
    const alias = mkProcess("shop", "prod", BUILD_ONE, { ready: true });
    const dropped = mkProcess("shop", "prod", BUILD_TWO, { ready: true });

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE)],
      actual: [alias, dropped],
      ports: countingPorts(),
    });

    expect(plan).toEqual([
      { type: "stop", processId: dropped.processId, reason: `superseded by build "${BUILD_ONE}"` },
    ]);
  });

  it("keeps every process an environment has while one of its legs is unresolved", () => {
    /*
     * A leg whose build record is gone from the registry — a corrupted or raced
     * state, since the reaper refuses to delete a build a split references. It
     * cannot be rolled out, and it must not be quietly dropped either: dropping
     * it would retire the process still serving it and hand its share of the
     * traffic to the other legs, over a build nobody withdrew. It counts as an
     * unproven leg, so nothing this environment runs is stopped.
     */
    const alias = mkProcess("shop", "prod", BUILD_ONE, { ready: true });
    const orphan = mkProcess("shop", "prod", BUILD_THREE, { ready: true });

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE, { unresolved: [BUILD_THREE] })],
      actual: [alias, orphan],
      ports: countingPorts(),
    });

    expect(plan).toEqual([]);
    expect(stoppedIds(plan)).not.toContain(orphan.processId);
  });
});

describe("an environment the registry no longer lists", () => {
  it("stops every process still running for it, saying why", () => {
    const first = mkProcess("shop", "prod", BUILD_ONE, { ready: true });
    const second = mkProcess("shop", "prod", BUILD_TWO, { ready: false });
    const ports = countingPorts();

    const plan = planReconcile({ desired: [], actual: [second, first], ports });

    expect(plan).toEqual([
      {
        type: "stop",
        processId: first.processId,
        reason: "environment is no longer served by this node",
      },
      {
        type: "stop",
        processId: second.processId,
        reason: "environment is no longer served by this node",
      },
    ]);
    expect(ports.calls).toBe(0);
  });

  it("handles it alongside the environments that are still wanted, stopping last", () => {
    const stranger = mkProcess("archive", "old", BUILD_ONE, { ready: true });
    const ports = countingPorts();

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_TWO)],
      actual: [stranger],
      ports,
    });

    expect(plan).toEqual([
      {
        type: "rollout",
        project: "shop",
        env: "prod",
        build: BUILD_TWO,
        ports: { public: PORT_START, internal: PORT_START + 1 },
      },
      {
        type: "stop",
        processId: stranger.processId,
        reason: "environment is no longer served by this node",
      },
    ]);
  });

  it("keeps environments of different projects that share a name apart", () => {
    const kept = mkProcess("shop", "prod", BUILD_ONE, { ready: true });
    const dropped = mkProcess("blog", "prod", BUILD_ONE, { ready: true });

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE)],
      actual: [kept, dropped],
      ports: countingPorts(),
    });

    expect(plan).toEqual([
      {
        type: "stop",
        processId: dropped.processId,
        reason: "environment is no longer served by this node",
      },
    ]);
  });
});

describe("a steady state", () => {
  it("plans nothing for an ephemeral environment already served by its own build", () => {
    const ports = countingPorts();

    const plan = planReconcile({
      desired: [mkDesired("shop", "preview", BUILD_ONE, { ephemeral: true })],
      actual: [mkProcess("shop", "preview", BUILD_ONE, { ready: true })],
      ports,
    });

    expect(plan).toEqual([]);
    expect(ports.calls).toBe(0);
  });

  it("plans nothing for a split whose every leg is already ready", () => {
    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE, { legs: [BUILD_TWO] })],
      actual: [
        mkProcess("shop", "prod", BUILD_ONE, { ready: true }),
        mkProcess("shop", "prod", BUILD_TWO, { ready: true, port: RUNNING_PORT + 2 }),
      ],
      ports: countingPorts(),
    });

    expect(plan).toEqual([]);
  });

  it("plans nothing for a second process of the same build, ready or not", () => {
    /*
     * A build never supersedes itself, so a redundant twin is not a stop
     * candidate; and one process of the build being ready satisfies the
     * environment, so the twin is not gated either. Pinned as it stands: such a
     * twin is left running untouched, pass after pass.
     */
    const serving = mkProcess("shop", "prod", BUILD_ONE, { ready: true });
    const twin = mkProcess("shop", "prod", BUILD_ONE, { ready: false, retry: 1 });

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE)],
      actual: [serving, twin],
      ports: countingPorts(),
    });

    expect(plan).toEqual([]);
    expect(stoppedIds(plan)).not.toContain(twin.processId);
  });

  it("ignores an unready twin of the wanted build while retiring the older ones", () => {
    const older = mkProcess("shop", "prod", BUILD_ONE, { ready: true });
    const serving = mkProcess("shop", "prod", BUILD_TWO, { ready: true });
    const twin = mkProcess("shop", "prod", BUILD_TWO, { ready: false, retry: 1 });

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_TWO)],
      actual: [older, serving, twin],
      ports: countingPorts(),
    });

    expect(plan).toEqual([
      { type: "stop", processId: older.processId, reason: `superseded by build "${BUILD_TWO}"` },
    ]);
  });
});

describe("the port allocator", () => {
  it("is asked exactly once for every process the plan starts", () => {
    const ports = countingPorts();

    const plan = planReconcile({
      desired: [
        mkDesired("shop", "prod", BUILD_ONE),
        mkDesired("shop", "preview", BUILD_TWO, { legs: [BUILD_THREE] }),
        mkDesired("blog", "prod", BUILD_THREE),
      ],
      actual: [],
      ports,
    });

    const started = rollouts(plan);
    expect(started).toHaveLength(4);
    expect(ports.calls).toBe(4);
    /* Every rollout carries its own pair, and no pair is handed out twice. */
    const allocated = started.flatMap((action) => [action.ports.public, action.ports.internal]);
    expect(new Set(allocated).size).toBe(allocated.length);
  });

  it("is not consulted at all by a plan that starts nothing", () => {
    const ports = countingPorts();

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_TWO), mkDesired("blog", "prod", BUILD_ONE)],
      actual: [
        mkProcess("shop", "prod", BUILD_ONE, { ready: true }),
        mkProcess("shop", "prod", BUILD_TWO, { ready: false }),
        mkProcess("blog", "prod", BUILD_ONE, { ready: true }),
        mkProcess("blog", "staging", BUILD_ONE, { ready: true }),
      ],
      ports,
    });

    expect(rollouts(plan)).toEqual([]);
    expect(ports.calls).toBe(0);
  });
});

describe("ordering", () => {
  it("plans several environments in the same order however the inputs are listed", () => {
    const input = busyInput();
    const expected = planReconcile(clone(input));

    for (let seed = 1; seed <= 25; seed++) {
      const rng = seededRng(seed);
      const shuffled = clone(input);
      const plan = planReconcile({
        desired: shuffle(shuffled.desired, rng),
        actual: shuffle(shuffled.actual, rng),
        ports: countingPorts(),
      });

      expect(plan, `for shuffle seed ${String(seed)}`).toEqual(expected);
    }
  });

  it("puts every stop after every rollout and gate, and groups the rest by environment", () => {
    /*
     * The phasing that is left, and the whole of it. Rollouts and gates are NOT
     * two phases any more — they interleave, per environment, in registry order
     * — because a leg that has to be started and a leg that only has to be gated
     * are both just "this leg is not ready yet". What is still a phase is the
     * stops: nothing is taken out of service until everything the pass is
     * bringing into service has been dealt with.
     */
    const plan = planReconcile(busyInput());

    const firstStop = plan.findIndex((action) => action.type === "stop");
    expect(firstStop).toBeGreaterThan(0);
    expect(plan.slice(firstStop).every((action) => action.type === "stop")).toBe(true);
    /* All three kinds are present, so the ordering above was actually exercised. */
    expect(new Set(plan.map((action) => action.type))).toEqual(
      new Set(["rollout", "await-ready", "stop"]),
    );
    /* And each environment's actions are contiguous, in registry order. */
    expect(environmentsOf(plan)).toEqual([...new Set(environmentsOf(plan))]);
  });
});

describe("across randomly generated states", () => {
  it("never stops a process before every leg of its environment is ready", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomInput(seededRng(seed));

      const plan = planReconcile(clone(input));
      const complaints = plan
        .filter((action) => action.type === "stop")
        .map((action) => stopVerdict(action, input))
        .filter((verdict) => verdict !== SAFE);

      expect(complaints, `for scenario seed ${String(seed)}`).toEqual([]);
    }
  });

  it("keeps the stops last and asks for one port pair per rollout", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomInput(seededRng(seed));
      const ports = countingPorts();

      const plan = planReconcile({ desired: input.desired, actual: input.actual, ports });

      const firstStop = plan.findIndex((action) => action.type === "stop");
      const tail = firstStop === -1 ? [] : plan.slice(firstStop);
      expect(
        tail.every((action) => action.type === "stop"),
        `for scenario seed ${String(seed)}`,
      ).toBe(true);
      expect(ports.calls, `for scenario seed ${String(seed)}`).toBe(rollouts(plan).length);
      /* Every process is spoken about at most once. */
      const ids = stoppedIds(plan);
      expect(new Set(ids).size, `for scenario seed ${String(seed)}`).toBe(ids.length);
    }
  });

  it("rolls out exactly one process for every leg nothing runs yet, and no other", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomInput(seededRng(seed));
      const plan = planReconcile(clone(input));

      for (const entry of input.desired) {
        for (const leg of entry.builds) {
          const serves = input.actual.some(
            (process) =>
              process.project === entry.project &&
              process.env === entry.env.name &&
              process.build === leg.build.id,
          );
          const started = plan.filter(
            (action) =>
              action.type === "rollout" &&
              action.project === entry.project &&
              action.env === entry.env.name &&
              action.build === leg.build.id,
          );

          const because = `for seed ${String(seed)}, ${entry.project}/${entry.env.name}`;
          expect(started.length, `${because} at ${leg.build.id}`).toBe(serves ? 0 : 1);
        }
      }
      /* And nothing is rolled out that no environment asked for. */
      for (const action of rollouts(plan)) {
        const wanted = input.desired.find(
          (entry) => entry.project === action.project && entry.env.name === action.env,
        );
        expect(
          wanted?.builds.map((leg) => leg.build.id),
          `for seed ${String(seed)}`,
        ).toContain(action.build);
      }
    }
  });

  it("plans the same actions however a generated state is listed", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomInput(seededRng(seed));
      const rng = seededRng(seed * 7 + 1);
      const expected = planReconcile(clone(input));

      const shuffled = clone(input);
      const plan = planReconcile({
        desired: shuffle(shuffled.desired, rng),
        actual: shuffle(shuffled.actual, rng),
        ports: countingPorts(),
      });

      expect(plan, `for scenario seed ${String(seed)}`).toEqual(expected);
    }
  });
});

/** What {@link stopVerdict} answers for a stop that breaks no rule. */
const SAFE = "safe";

/**
 * Whether one planned stop was allowed, and what is wrong with it when it was
 * not. A process may only be stopped when its environment has left desired state
 * altogether, or when EVERY build that environment is wanted at has a process
 * that has passed its readiness gate — and the process being stopped is at none
 * of those builds.
 */
function stopVerdict(
  action: Extract<ReconcileAction, { type: "stop" }>,
  input: ReconcileInput,
): string {
  const stopped = input.actual.find((process) => process.processId === action.processId);
  if (stopped === undefined) return `"${action.processId}" is not running on this node`;

  const wanted = input.desired.find(
    (entry) => entry.project === stopped.project && entry.env.name === stopped.env,
  );
  if (wanted === undefined) {
    return action.reason === "environment is no longer served by this node"
      ? SAFE
      : `"${action.processId}" serves no wanted environment but was stopped as "${action.reason}"`;
  }

  const legs = wanted.builds.map((leg) => leg.build.id);
  if (legs.includes(stopped.build)) {
    return `"${action.processId}" serves a build its environment is wanted at`;
  }
  if ((wanted.unresolved ?? []).length > 0) {
    return `"${action.processId}" was stopped while its environment had an unresolved leg`;
  }

  const unproven = legs.filter(
    (build) =>
      !input.actual.some(
        (process) =>
          process.project === stopped.project &&
          process.env === stopped.env &&
          process.build === build &&
          process.ready,
      ),
  );
  if (unproven.length > 0) {
    return `"${action.processId}" was stopped while ${unproven.join(", ")} had no ready process`;
  }

  const named = legs.map((build) => `"${build}"`).join(", ");
  const expected =
    legs.length === 1 ? `superseded by build ${named}` : `superseded by builds ${named}`;
  return action.reason === expected
    ? SAFE
    : `"${action.processId}" was retired as "${action.reason}", which names the wrong builds`;
}

/** Hands out sequential pairs and counts how often a plan asked for one. */
interface CountingPorts extends PortView {
  /** Pairs handed out so far. */
  calls: number;
}

function countingPorts(start: number = PORT_START): CountingPorts {
  let next = start;
  const view: CountingPorts = {
    calls: 0,
    nextPorts(): { public: number; internal: number } {
      view.calls++;
      const pair = { public: next, internal: next + 1 };
      next += 2;
      return pair;
    },
  };
  return view;
}

interface DesiredOptions {
  ephemeral?: boolean;
  varsetId?: string;
  /** Builds the environment also splits its traffic to, beyond its alias. */
  legs?: string[];
  /** Split legs whose build record could not be read. */
  unresolved?: string[];
}

/** One environment as the registry wants it served, with its builds resolved. */
function mkDesired(
  project: string,
  env: string,
  build: string,
  opts?: DesiredOptions,
): DesiredEnvironment {
  const legs = opts?.legs ?? [];
  const unresolved = opts?.unresolved ?? [];
  /* Deduped the way the reader dedupes it: the alias may itself be a leg. */
  const ids = [build, ...legs.filter((leg) => leg !== build)];
  const split: SplitEntry[] =
    legs.length + unresolved.length === 0
      ? []
      : [...legs, ...unresolved].map((leg, at, all) => ({
          build: leg,
          weight: at === 0 ? 100 - all.length + 1 : 1,
        }));

  const wanted: DesiredEnvironment = {
    project,
    env: {
      v: 1,
      name: env,
      prefix: `fleets/${project}/${env}`,
      alias: { build, flippedAt: FLIPPED_AT },
      split: split.length === 0 ? null : split,
      domains: [],
      placement: "auto",
      ephemeral: opts?.ephemeral ?? false,
      createdAt: CREATED_AT,
    },
    builds: ids.map((id, at) => ({
      build: mkBuild(project, id),
      role: at === 0 ? "alias" : "split",
    })),
  };
  if (unresolved.length > 0) wanted.unresolved = [...unresolved];
  if (opts?.varsetId !== undefined) wanted.varsetId = opts.varsetId;
  return wanted;
}

function mkBuild(project: string, build: string): BuildRecord {
  return {
    v: 1,
    id: build,
    artifact: `artifacts/${project}/${build}.tar.zst`,
    celldVersionId: `version-${build}`,
    runtimeConfigurable: true,
    createdAt: CREATED_AT,
  };
}

interface ProcessOptions {
  ready?: boolean;
  /** Public port; the internal one follows it. */
  port?: number;
  /** Attempt number, for a second process of the same three parts. */
  retry?: number;
}

/** One process running on this node, as the planner sees it. */
function mkProcess(
  project: string,
  env: string,
  build: string,
  opts?: ProcessOptions,
): RuntimeProcess {
  const port = opts?.port ?? RUNNING_PORT;
  return {
    processId: formatProcessId({ project, env, build, retry: opts?.retry }),
    project,
    env,
    build,
    port,
    internalPort: port + 1,
    ready: opts?.ready ?? false,
  };
}

/** A state exercising every kind of action at once, across two projects. */
function busyInput(): ReconcileInput {
  return {
    desired: [
      /* Nothing runs it yet: one rollout. */
      mkDesired("shop", "prod", BUILD_THREE),
      /* Served by the wanted build already, with an older one to retire. */
      mkDesired("shop", "preview", BUILD_TWO, { ephemeral: true }),
      /* Replacement running but unproven: gate only. */
      mkDesired("blog", "prod", BUILD_TWO),
      /* A split with one leg up and one still to start. */
      mkDesired("blog", "staging", BUILD_ONE, { legs: [BUILD_THREE] }),
    ],
    actual: [
      mkProcess("shop", "preview", BUILD_ONE, { ready: true, port: RUNNING_PORT }),
      mkProcess("shop", "preview", BUILD_TWO, { ready: true, port: RUNNING_PORT + 2 }),
      mkProcess("blog", "prod", BUILD_ONE, { ready: true, port: RUNNING_PORT + 4 }),
      mkProcess("blog", "prod", BUILD_TWO, { ready: false, port: RUNNING_PORT + 6 }),
      mkProcess("blog", "staging", BUILD_ONE, { ready: true, port: RUNNING_PORT + 8 }),
      /* Serves an environment nobody asked for. */
      mkProcess("archive", "old", BUILD_ONE, { ready: true, port: RUNNING_PORT + 10 }),
    ],
    ports: countingPorts(),
  };
}

/** Pools the generated states are drawn from; small enough that states collide. */
const PROJECTS = ["shop", "blog"];
const ENVIRONMENTS = ["prod", "preview", "staging"];
const BUILDS = [BUILD_ONE, BUILD_TWO, BUILD_THREE];

/** A random mix of wanted environments — some of them split — and running processes. */
function randomInput(rng: () => number): ReconcileInput {
  const desired: DesiredEnvironment[] = [];
  const actual: RuntimeProcess[] = [];
  let port = RUNNING_PORT;

  for (const project of PROJECTS) {
    for (const env of ENVIRONMENTS) {
      if (rng() < 0.75) {
        const legs = BUILDS.filter(() => rng() < 0.3);
        const unresolved = rng() < 0.1 ? ["dddd4444"] : [];
        desired.push(
          mkDesired(project, env, pick(BUILDS, rng), {
            ...(legs.length === 0 ? {} : { legs }),
            ...(unresolved.length === 0 ? {} : { unresolved }),
          }),
        );
      }

      const count = Math.floor(rng() * 4);
      const used = new Set<string>();
      for (let i = 0; i < count; i++) {
        const build = pick(BUILDS, rng);
        /* Two processes of the same build need distinct ids, which is what the
           retry suffix is for. */
        const retry = used.has(build) ? i : undefined;
        used.add(build);
        actual.push(mkProcess(project, env, build, { ready: rng() < 0.5, port, retry }));
        port += 2;
      }
    }
  }
  return { desired, actual, ports: countingPorts() };
}

function pick<T>(values: T[], rng: () => number): T {
  return values[Math.floor(rng() * values.length)];
}

function rollouts(plan: ReconcileAction[]): Array<Extract<ReconcileAction, { type: "rollout" }>> {
  return plan.filter((action) => action.type === "rollout");
}

function builtBy(plan: ReconcileAction[]): string[] {
  return rollouts(plan).map((action) => action.build);
}

/** The environment each non-stop action concerns, in plan order and without repeats. */
function environmentsOf(plan: ReconcileAction[]): string[] {
  const seen: string[] = [];
  for (const action of plan) {
    if (action.type !== "rollout") continue;
    const key = `${action.project}/${action.env}`;
    if (seen.at(-1) !== key) seen.push(key);
  }
  return seen;
}

function stops(plan: ReconcileAction[]): ReconcileAction[] {
  return plan.filter((action) => action.type === "stop");
}

function stoppedIds(plan: ReconcileAction[]): string[] {
  return plan.filter((action) => action.type === "stop").map((action) => action.processId);
}

/** A fresh input with a fresh allocator, so replanning starts from the same ports. */
function clone(input: ReconcileInput): ReconcileInput {
  return { desired: [...input.desired], actual: [...input.actual], ports: countingPorts() };
}

/** Fisher-Yates against a seeded source, so a failing order can be replayed. */
function shuffle<T>(values: T[], rng: () => number): T[] {
  const shuffled = [...values];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
