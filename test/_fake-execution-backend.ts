import {
  type BuilderExecutionIntent,
  type ExecutionBackend,
  type ExecutionCapabilities,
  type ExecutionHandle,
  type ExecutionIntent,
  type ExecutionLaunch,
  type LaunchSpec,
  type ExecutionStatus,
  type ClosedExecutionStatus,
  type ExecutionStopOptions,
  type RunningExecutionStatus,
  type RuntimeExecutionIntent,
  type TaskResult,
  resolveWorkloadLimits,
} from "../src/core/types/execution.ts";
import { ScafoError } from "../src/core/error.ts";
import type {
  ExecutionBackendFixture,
  ExecutionEgressAttempt,
  ExecutionEgressDestinations,
  ExecutionLogOverflow,
} from "./_execution-backend-conformance.ts";

interface TaskGate {
  readonly entered: Deferred<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

/** A deterministic backend used only to prove the portable contract suite. */
export class FakeExecutionBackend implements ExecutionBackend {
  readonly #running = new Map<string, RunningExecutionStatus>();
  readonly #history = new Map<string, ClosedExecutionStatus>();
  readonly #environments = new Map<string, Readonly<Record<string, string>>>();
  readonly #abortListeners = new Map<string, () => void>();
  readonly #leaveRunningOnStop: boolean;
  readonly #allowBuilderEgress: boolean;
  readonly #allowRuntimeDirectEgress: boolean;
  readonly #allowProtectedMediatedEgress: boolean;
  readonly #leaveRunningOnTaskAbort: boolean;
  readonly #leaveLogTailUnbounded: boolean;
  readonly #egressDestinations: ExecutionEgressDestinations;
  readonly #logOverflow: ExecutionLogOverflow;
  #taskGate: TaskGate | undefined;

  constructor(opts?: {
    leaveRunningOnStop?: boolean;
    allowBuilderEgress?: boolean;
    allowRuntimeDirectEgress?: boolean;
    allowProtectedMediatedEgress?: boolean;
    leaveRunningOnTaskAbort?: boolean;
    leaveLogTailUnbounded?: boolean;
    egressDestinations?: ExecutionEgressDestinations;
    logOverflow?: ExecutionLogOverflow;
  }) {
    this.#leaveRunningOnStop = opts?.leaveRunningOnStop ?? false;
    this.#allowBuilderEgress = opts?.allowBuilderEgress ?? false;
    this.#allowRuntimeDirectEgress = opts?.allowRuntimeDirectEgress ?? false;
    this.#allowProtectedMediatedEgress = opts?.allowProtectedMediatedEgress ?? false;
    this.#leaveRunningOnTaskAbort = opts?.leaveRunningOnTaskAbort ?? false;
    this.#leaveLogTailUnbounded = opts?.leaveLogTailUnbounded ?? false;
    this.#egressDestinations = opts?.egressDestinations ?? FAKE_EGRESS_DESTINATIONS;
    this.#logOverflow = opts?.logOverflow ?? FAKE_LOG_OVERFLOW;
  }

  async probe(): Promise<ExecutionCapabilities> {
    return capabilities();
  }

  async runTask(
    intent: BuilderExecutionIntent,
    launch: ExecutionLaunch,
    opts: { signal: AbortSignal },
  ): Promise<TaskResult> {
    const status = this.#start(intent, launch);
    if (opts.signal.aborted) {
      this.#close(status, "cancelled");
      throw abortReason(opts.signal);
    }
    const gate = this.#taskGate;
    this.#taskGate = undefined;
    if (gate !== undefined) await this.#waitForTaskAbort(gate, status, opts.signal);
    if (this.#leaveRunningOnTaskAbort && opts.signal.aborted)
      return { status: status as unknown as ClosedExecutionStatus };
    const closed = this.#close(status, "completed");
    return { status: closed };
  }

  /** Test-only egress evaluator used by the portable conformance fixture. */
  async attemptEgress(attempt: ExecutionEgressAttempt): Promise<void> {
    const protectedDestinations = Object.values(this.#egressDestinations.protected);
    const publicDestinations = Object.values(this.#egressDestinations.publicWeb);
    if (![...publicDestinations, ...protectedDestinations].includes(attempt.destination))
      throw egressDenied("Fixture attempted an uncontrolled egress destination");
    if (attempt.role === "builder") {
      if (this.#allowBuilderEgress) return;
      throw egressDenied("Builder egress is denied");
    }
    if (attempt.path === "direct") {
      if (this.#allowRuntimeDirectEgress) return;
      throw egressDenied("Runtime direct egress is denied");
    }
    if (protectedDestinations.includes(attempt.destination)) {
      if (this.#allowProtectedMediatedEgress) return;
      throw egressDenied("Runtime mediated egress to protected destinations is denied");
    }
  }

  /** Test-only retained-tail overflow driver used by the portable conformance fixture. */
  async overflowLogs(): Promise<ExecutionHandle> {
    const handle = await this.startService(intent("runtime", "log-overflow"), () => launchSpec(), {
      signal: new AbortController().signal,
    });
    const status = this.#running.get(handle.id);
    if (status?.handle.generation === handle.generation) {
      const logTail = this.#leaveLogTailUnbounded
        ? [...status.logTail, ...this.#logOverflow.emittedLines]
        : this.#logOverflow.emittedLines.slice(-this.#logOverflow.retainedTailCapacity);
      this.#running.set(handle.id, { ...status, logTail });
    }
    return handle;
  }

  /** Test-only gate that records a task entering execution before its caller aborts. */
  beginTaskGate(): TaskGate {
    const gate = { entered: deferred<void>() };
    this.#taskGate = gate;
    return gate;
  }

  async startService(
    intent: RuntimeExecutionIntent,
    launch: ExecutionLaunch,
    opts: { signal: AbortSignal },
  ): Promise<ExecutionHandle> {
    const status = this.#start(intent, launch);
    if (opts.signal.aborted) {
      this.#close(status, "cancelled");
      throw abortReason(opts.signal);
    }
    const removeAbort = (): void => {
      opts.signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      queueMicrotask(() => {
        const current = this.#running.get(status.handle.id);
        if (current?.handle.generation === status.handle.generation)
          this.#close(current, "cancelled");
      });
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });
    this.#abortListeners.set(keyOf(status.handle), removeAbort);
    return status.handle;
  }

  async list(scope: { installationId: string; nodeId: string }): Promise<ExecutionHandle[]> {
    return [...this.#running.values()]
      .filter(
        (status) =>
          status.identity.installationId === scope.installationId &&
          status.identity.nodeId === scope.nodeId,
      )
      .map((status) => status.handle);
  }

  async inspect(handle: ExecutionHandle): Promise<ExecutionStatus | null> {
    const running = this.#running.get(handle.id);
    if (running !== undefined)
      return running.handle.generation === handle.generation ? running : null;
    return this.#history.get(keyOf(handle)) ?? null;
  }

  async stop(handle: ExecutionHandle, opts: ExecutionStopOptions): Promise<void> {
    const status = this.#running.get(handle.id);
    if (status === undefined || status.handle.generation !== handle.generation) return;
    if (this.#leaveRunningOnStop) return;
    this.#close(status, opts.mode === "abort" ? "cancelled" : "stopped");
  }

  environment(handle: ExecutionHandle): Readonly<Record<string, string>> | null {
    const running = this.#running.get(handle.id);
    if (running !== undefined && running.handle.generation !== handle.generation) return null;
    return this.#environments.get(keyOf(handle)) ?? null;
  }

  #start(intent: ExecutionIntent, launch: ExecutionLaunch): RunningExecutionStatus {
    resolveWorkloadLimits(intent.resources, capabilities());
    const previous = this.#running.get(intent.identity.executionId);
    if (previous !== undefined) this.#close(previous, "stopped");
    const bindings = {
      listeners: [{ name: "http", address: "127.0.0.1:1" }],
      capabilities: intent.capabilities,
      reservedEnv: { SCAFO_GENERATION: intent.identity.generation },
    } as const;
    const spec = launch(bindings);
    const status: RunningExecutionStatus = {
      handle: { id: intent.identity.executionId, generation: intent.identity.generation },
      identity: intent.identity,
      state: "running",
      logTail: ["ready"],
      endpoints: [{ name: "http", address: "http://dial.test/service" }],
      usage: {},
    };
    this.#running.set(status.handle.id, status);
    this.#environments.set(keyOf(status.handle), { ...spec.env, ...bindings.reservedEnv });
    return status;
  }

  #close(
    status: RunningExecutionStatus,
    reason: ClosedExecutionStatus["closedReason"],
  ): ClosedExecutionStatus {
    const closed: ClosedExecutionStatus = { ...status, state: "closed", closedReason: reason };
    const current = this.#running.get(status.handle.id);
    if (current?.handle.generation === status.handle.generation)
      this.#running.delete(status.handle.id);
    this.#abortListeners.get(keyOf(status.handle))?.();
    this.#abortListeners.delete(keyOf(status.handle));
    this.#history.set(keyOf(status.handle), closed);
    return closed;
  }

  #waitForTaskAbort(
    gate: TaskGate,
    status: RunningExecutionStatus,
    signal: AbortSignal,
  ): Promise<void> {
    gate.entered.resolve();
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          if (this.#leaveRunningOnTaskAbort) {
            resolve();
            return;
          }
          this.#close(status, "cancelled");
          reject(abortReason(signal));
        },
        { once: true },
      );
    });
  }
}

/** Fixture for this fake and any focused failure sentinel built from it. */
export function fakeExecutionBackendFixture(opts?: {
  leaveRunningOnStop?: boolean;
  allowBuilderEgress?: boolean;
  allowRuntimeDirectEgress?: boolean;
  allowProtectedMediatedEgress?: boolean;
  leaveRunningOnTaskAbort?: boolean;
  leaveLogTailUnbounded?: boolean;
}): ExecutionBackendFixture {
  const backend = new FakeExecutionBackend({
    ...opts,
    egressDestinations: FAKE_EGRESS_DESTINATIONS,
    logOverflow: FAKE_LOG_OVERFLOW,
  });
  return {
    backend,
    builderIntent: (generation) => intent("builder", generation),
    runtimeIntent: (generation) => intent("runtime", generation),
    limitedRuntimeIntent: () => ({
      ...intent("runtime", "limited"),
      resources: { memoryBytes: 512 },
    }),
    unsupportedLimitIntent: () => ({
      ...intent("runtime", "unsupported"),
      resources: { openFiles: 4 },
    }),
    scope: { installationId: "installation", nodeId: "node" },
    environment: (handle) => backend.environment(handle),
    egressDestinations: FAKE_EGRESS_DESTINATIONS,
    attemptEgress: (attempt) => backend.attemptEgress(attempt),
    logOverflow: FAKE_LOG_OVERFLOW,
    overflowLogs: () => backend.overflowLogs(),
    gatedBuilderTask: (signal) => {
      const gate = backend.beginTaskGate();
      return {
        entered: gate.entered.promise,
        result: backend.runTask(intent("builder", "gated-task"), () => launchSpec(), { signal }),
      };
    },
    launch: () => launchSpec(),
  };
}

function intent(role: "builder", generation: string): BuilderExecutionIntent;
function intent(role: "runtime", generation: string): RuntimeExecutionIntent;
function intent(role: "builder" | "runtime", generation: string): ExecutionIntent {
  const base = {
    identity: {
      installationId: "installation",
      nodeId: "node",
      projectId: "project",
      environmentId: "environment",
      buildId: "build",
      executionId: "service",
      generation,
    },
    isolation: "sandbox" as const,
    runtimeBundleDigest: "sha256:bundle",
    inputs: [],
    scratch: { id: "scratch" },
    capabilities: [{ id: "capability" }],
    listeners: [{ name: "http", protocol: "http" as const }],
    lease: { id: "lease", expiresAt: "2026-01-01T00:00:00.000Z" },
  };
  return role === "builder"
    ? { ...base, role, egress: { mode: "none" } }
    : { ...base, role, egress: { mode: "mediated-web" } };
}

function capabilities(): ExecutionCapabilities {
  return {
    isolationModes: ["sandbox"],
    workloadLimits: ["cpuMillicores", "memoryBytes", "pids", "scratchBytes", "scratchInodes"],
    features: {
      cancellation: true,
      groupTeardown: true,
      generationFence: true,
      namedListeners: true,
      boundedLogs: true,
      readOnlyInputs: true,
      privateScratch: true,
      filesystemIsolation: true,
      networkIsolation: true,
      protectedNetworkDeny: true,
      builderEgressDeny: true,
      egressMediation: true,
      scopedCapabilities: true,
      lifecycleLease: true,
    },
  };
}

function keyOf(handle: ExecutionHandle): string {
  return `${handle.id}:${handle.generation}`;
}

function launchSpec(): LaunchSpec {
  return { command: "app", args: [], env: {} };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const FAKE_EGRESS_DESTINATIONS: ExecutionEgressDestinations = {
  publicWeb: {
    http: "http://public-http.fixture.invalid",
    https: "https://public-https.fixture.invalid",
    ws: "ws://public-ws.fixture.invalid",
    wss: "wss://public-wss.fixture.invalid",
  },
  protected: {
    localhostName: "http://localhost.fixture.invalid",
    ipv4Unspecified: "http://0.0.0.0",
    ipv4Loopback: "http://127.0.0.1",
    ipv4LinkLocal: "http://169.254.0.1",
    ipv4Private: "http://192.168.0.1",
    ipv4Cgnat: "http://100.64.0.1",
    ipv4ReservedOrMetadata: "http://169.254.169.254",
    ipv6Unspecified: "http://[::]",
    ipv6Loopback: "http://[::1]",
    ipv6LinkLocal: "http://[fe80::1]",
    ipv6Ula: "http://[fd00::1]",
    hostnameRebinding: "http://rebind.fixture.invalid",
  },
};

const FAKE_LOG_OVERFLOW: ExecutionLogOverflow = {
  retainedTailCapacity: 3,
  emittedLines: ["log-1", "log-2", "log-3", "log-4", "log-5"],
};

function egressDenied(message: string): ScafoError {
  return new ScafoError("capability-missing", message);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Execution start was aborted", "AbortError");
}
