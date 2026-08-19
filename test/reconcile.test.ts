/*
 * The pure reconcile planner: what this node must do to serve what the registry
 * wants, and the order it must do it in.
 *
 * The property every case here defends is the platform's zero-downtime
 * guarantee: a process that still serves an environment is never planned for a
 * stop until a replacement for that environment is running AND has passed its
 * readiness gate. A flip that stopped the old process first would drop every
 * request the new one cannot answer yet, and a replacement that never becomes
 * ready would leave the environment with nothing serving at all.
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

/** The phases a plan is emitted in, in the order they must be executed. */
const PHASES: ReconcileAction["type"][] = ["activate", "start", "await-ready", "stop"];

describe("an environment with nothing running for it", () => {
  it("points the fleet at the build, starts a process on an allocated pair, then gates it", () => {
    const ports = countingPorts();

    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE)],
      actual: [],
      ports,
    });

    expect(plan).toEqual([
      { type: "activate", project: "shop", env: "prod", build: BUILD_ONE },
      {
        type: "start",
        project: "shop",
        env: "prod",
        build: BUILD_ONE,
        ports: { public: PORT_START, internal: PORT_START + 1 },
      },
      { type: "await-ready", processId: `shop--prod--${BUILD_ONE}` },
    ]);
    /* The gate names the id the process will be started under, which is the
       conventional one for the three parts it serves. */
    expect(plan[2]).toEqual({
      type: "await-ready",
      processId: formatProcessId({ project: "shop", env: "prod", build: BUILD_ONE }),
    });
    expect(stops(plan)).toEqual([]);
    expect(ports.calls).toBe(1);
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
    expect(plan.filter((action) => action.type === "activate")).toEqual([]);
    expect(plan.filter((action) => action.type === "start")).toEqual([]);
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
     * Nothing is loaded and nothing is started, because both builds already run.
     *
     * A rollback therefore plans no activation, and the fleet's deployment
     * pointer keeps naming the build that was rolled back FROM for as long as a
     * process of the aliased build survives. Nothing loads the abandoned build
     * from it: an activation is planned together with every start, so the
     * pointer is corrected before the next process reads it.
     */
    expect(plan.filter((action) => action.type === "activate")).toEqual([]);
    expect(plan.filter((action) => action.type === "start")).toEqual([]);
  });

  it("points the fleet at the build it was rolled back to before starting a replacement", () => {
    /* The pointer left behind above, corrected the moment the environment has
       nothing serving it: a start is never planned without the activation that
       decides what that process will load. */
    const plan = planReconcile({
      desired: [mkDesired("shop", "prod", BUILD_ONE)],
      actual: [],
      ports: countingPorts(),
    });

    expect(plan[0]).toEqual({
      type: "activate",
      project: "shop",
      env: "prod",
      build: BUILD_ONE,
    });
    expect(plan[1]).toMatchObject({ type: "start", build: BUILD_ONE });
  });
});

describe("an environment the registry no longer lists", () => {
  it("stops every process still running for it, saying why", () => {
    const first = mkProcess("shop", "prod", BUILD_ONE, { ready: true });
    const second = mkProcess("shop", "prod", BUILD_TWO, { ready: false });
    const ports = countingPorts();

    const plan = planReconcile({ desired: [], actual: [second, first], ports });

    expect(plan).toEqual([
      { type: "stop", processId: first.processId, reason: "environment is no longer deployed" },
      { type: "stop", processId: second.processId, reason: "environment is no longer deployed" },
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
      { type: "activate", project: "shop", env: "prod", build: BUILD_TWO },
      {
        type: "start",
        project: "shop",
        env: "prod",
        build: BUILD_TWO,
        ports: { public: PORT_START, internal: PORT_START + 1 },
      },
      { type: "await-ready", processId: `shop--prod--${BUILD_TWO}` },
      { type: "stop", processId: stranger.processId, reason: "environment is no longer deployed" },
    ]);
    expect(phasesOf(plan)).toEqual(["activate", "start", "await-ready", "stop"]);
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
      { type: "stop", processId: dropped.processId, reason: "environment is no longer deployed" },
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
        mkDesired("shop", "preview", BUILD_TWO),
        mkDesired("blog", "prod", BUILD_THREE),
      ],
      actual: [],
      ports,
    });

    const starts = plan.filter((action) => action.type === "start");
    expect(starts).toHaveLength(3);
    expect(ports.calls).toBe(3);
    /* Every start carries its own pair, and no pair is handed out twice. */
    const allocated = starts.flatMap((action) => [action.ports.public, action.ports.internal]);
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

    expect(plan.filter((action) => action.type === "start")).toEqual([]);
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

  it("groups a plan into activations, starts, gates and stops, in that order", () => {
    const plan = planReconcile(busyInput());

    expect(phasesOf(plan)).toEqual(["activate", "start", "await-ready", "stop"]);
    /* All four phases are present, so the ordering above was actually exercised. */
    expect(new Set(plan.map((action) => action.type))).toEqual(new Set(PHASES));
  });
});

describe("across randomly generated states", () => {
  it("never stops a process before a ready replacement exists for its environment", () => {
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

  it("keeps the phases in execution order and asks for one port pair per start", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomInput(seededRng(seed));
      const ports = countingPorts();

      const plan = planReconcile({ desired: input.desired, actual: input.actual, ports });

      expect(phasesOf(plan), `for scenario seed ${String(seed)}`).toEqual(
        PHASES.filter((phase) => plan.some((action) => action.type === phase)),
      );
      expect(ports.calls, `for scenario seed ${String(seed)}`).toBe(
        plan.filter((action) => action.type === "start").length,
      );
      /* Every process is spoken about at most once. */
      const ids = stoppedIds(plan);
      expect(new Set(ids).size, `for scenario seed ${String(seed)}`).toBe(ids.length);
    }
  });

  it("starts exactly one process for every environment nothing runs yet", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomInput(seededRng(seed));
      const plan = planReconcile(clone(input));

      for (const entry of input.desired) {
        const serves = input.actual.some(
          (process) =>
            process.project === entry.project &&
            process.env === entry.env.name &&
            process.build === entry.build.id,
        );
        const started = plan.filter(
          (action) =>
            action.type === "start" &&
            action.project === entry.project &&
            action.env === entry.env.name,
        );
        const activated = plan.filter(
          (action) =>
            action.type === "activate" &&
            action.project === entry.project &&
            action.env === entry.env.name,
        );

        const because = `for seed ${String(seed)}, ${entry.project}/${entry.env.name}`;
        expect(started.length, `${because}: starts`).toBe(serves ? 0 : 1);
        expect(activated.length, `${because}: activations`).toBe(serves ? 0 : 1);
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
 * altogether, or when another process of that environment already serves the
 * build it is wanted at AND has passed its readiness gate.
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
    return action.reason === "environment is no longer deployed"
      ? SAFE
      : `"${action.processId}" serves no wanted environment but was stopped as "${action.reason}"`;
  }

  if (stopped.build === wanted.build.id) {
    return `"${action.processId}" serves the very build its environment is wanted at`;
  }
  const replaced = input.actual.some(
    (process) =>
      process.project === stopped.project &&
      process.env === stopped.env &&
      process.build === wanted.build.id &&
      process.ready,
  );
  if (!replaced) return `"${action.processId}" was stopped with no ready replacement running`;

  return action.reason === `superseded by build "${wanted.build.id}"`
    ? SAFE
    : `"${action.processId}" was retired as "${action.reason}", which names the wrong build`;
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
}

/** One environment as the registry wants it served, with its alias resolved. */
function mkDesired(
  project: string,
  env: string,
  build: string,
  opts?: DesiredOptions,
): DesiredEnvironment {
  const wanted: DesiredEnvironment = {
    project,
    env: {
      v: 1,
      name: env,
      prefix: `fleets/${project}/${env}`,
      alias: { build, flippedAt: FLIPPED_AT },
      split: null,
      domains: [],
      placement: "auto",
      ephemeral: opts?.ephemeral ?? false,
      createdAt: CREATED_AT,
    },
    build: {
      v: 1,
      id: build,
      artifact: `artifacts/${project}/${build}.tar.zst`,
      celldVersionId: `version-${build}`,
      runtimeConfigurable: true,
      createdAt: CREATED_AT,
    },
  };
  if (opts?.varsetId !== undefined) wanted.varsetId = opts.varsetId;
  return wanted;
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

/** A state exercising all four phases at once, across two projects. */
function busyInput(): ReconcileInput {
  return {
    desired: [
      /* Nothing runs it yet: activate, start, gate. */
      mkDesired("shop", "prod", BUILD_THREE),
      /* Served by the wanted build already, with an older one to retire. */
      mkDesired("shop", "preview", BUILD_TWO, { ephemeral: true }),
      /* Replacement running but unproven: gate only. */
      mkDesired("blog", "prod", BUILD_TWO),
      /* Steady state: nothing to do at all. */
      mkDesired("blog", "staging", BUILD_ONE),
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

/** A random mix of wanted environments and running processes. */
function randomInput(rng: () => number): ReconcileInput {
  const desired: DesiredEnvironment[] = [];
  const actual: RuntimeProcess[] = [];
  let port = RUNNING_PORT;

  for (const project of PROJECTS) {
    for (const env of ENVIRONMENTS) {
      if (rng() < 0.75) desired.push(mkDesired(project, env, pick(BUILDS, rng)));

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

/** The phases a plan is made of, in the order they appear and without repeats. */
function phasesOf(plan: ReconcileAction[]): ReconcileAction["type"][] {
  const seen: ReconcileAction["type"][] = [];
  for (const action of plan) {
    if (seen.at(-1) !== action.type) seen.push(action.type);
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
