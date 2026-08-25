/*
 * The boundary between Scafo and a sandbox implementation. Core names the
 * policy and lifecycle; a backend owns every host-facing operation needed to
 * enforce them.
 */

import { ScafoError } from "../error.ts";

/** A workload resource a backend may optionally enforce. */
export type WorkloadLimitName =
  | "cpuMillicores"
  | "memoryBytes"
  | "pids"
  | "openFiles"
  | "scratchBytes"
  | "scratchInodes";

/**
 * Optional operator policy limits for one workload. Omission is the only
 * unbounded representation; every supplied value must be a positive safe integer.
 */
export interface WorkloadLimits {
  readonly cpuMillicores?: number;
  readonly memoryBytes?: number;
  readonly pids?: number;
  readonly openFiles?: number;
  readonly scratchBytes?: number;
  readonly scratchInodes?: number;
}

/**
 * Validates selected workload limits without inventing defaults or clamping.
 * A backend is only asked to prove enforcement for fields an operator selected.
 */
export function resolveWorkloadLimits(
  limits: unknown,
  capabilities?: Pick<ExecutionCapabilities, "workloadLimits">,
): Readonly<WorkloadLimits> | undefined {
  if (limits === undefined) return undefined;
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
    throw invalidWorkloadLimits("must be an object when supplied");
  }

  const written = limits as Record<string, unknown>;
  const entries = Object.entries(written);
  if (entries.length === 0) return undefined;
  for (const [name, value] of entries) {
    if (!WORKLOAD_LIMIT_NAMES.includes(name as WorkloadLimitName)) {
      throw invalidWorkloadLimits(`names unknown limit "${name}"`);
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw invalidWorkloadLimits(
        `"${name}" must be a positive safe integer; omit it for no backend quota`,
      );
    }
    if (
      capabilities !== undefined &&
      !capabilities.workloadLimits.includes(name as WorkloadLimitName)
    ) {
      throw new ScafoError(
        "capability-missing",
        "Execution backend cannot enforce workload limit",
        {
          detail: `The selected backend cannot enforce "${name}"; remove that limit or choose a backend that can`,
        },
      );
    }
  }
  return { ...limits };
}

function invalidWorkloadLimits(detail: string): ScafoError {
  return new ScafoError("invalid-input", "Invalid execution workload limits", { detail });
}

const WORKLOAD_LIMIT_NAMES: readonly WorkloadLimitName[] = [
  "cpuMillicores",
  "memoryBytes",
  "pids",
  "openFiles",
  "scratchBytes",
  "scratchInodes",
];

/** Work is finite for a builder and long-lived for a runtime service. */
export type ExecutionRole = "builder" | "runtime";

/** Only an enforcing sandbox is part of this contract's secure mode. */
export type ExecutionIsolation = "sandbox";

/** Immutable identity carried by every execution and returned in its status. */
export interface ExecutionIdentity {
  readonly installationId: string;
  readonly nodeId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly buildId: string;
  readonly executionId: string;
  /** A random value fencing every replacement of this logical execution. */
  readonly generation: string;
}

/** Read-only material addressed by content identity rather than a host path. */
export interface ExecutionInput {
  readonly id: string;
  readonly digest: string;
}

/** An opaque reference a sandbox can bind without learning root credentials. */
export interface CapabilityReference {
  readonly id: string;
}

/** A listener the workload asks the sandbox to prepare under a stable name. */
export interface RequestedListener {
  readonly name: string;
  readonly protocol: "http" | "https" | "ws" | "wss";
}

/** Builder egress is none; runtime egress is only mediated public web traffic. */
export type EgressPolicy =
  | { readonly mode: "none" }
  | { readonly mode: "mediated-web"; readonly allowlist?: readonly string[] };

/** A guardian lease a sandbox holds while this execution exists. */
export interface ExecutionLease {
  readonly id: string;
  readonly expiresAt: string;
}

/** Everything a backend needs before it prepares a sandbox, never host secrets or paths. */
interface ExecutionIntentBase {
  readonly identity: ExecutionIdentity;
  readonly isolation: ExecutionIsolation;
  readonly runtimeBundleDigest: string;
  readonly inputs: readonly ExecutionInput[];
  readonly scratch: { readonly id: string };
  readonly capabilities: readonly CapabilityReference[];
  readonly listeners: readonly RequestedListener[];
  readonly lease: ExecutionLease;
}

/** Finite build work has no network egress. */
export interface BuilderExecutionIntent extends ExecutionIntentBase {
  readonly role: "builder";
  readonly resources?: Readonly<WorkloadLimits>;
  readonly egress: { readonly mode: "none" };
}

/** Long-lived work uses mediated web egress only. */
export interface RuntimeExecutionIntent extends ExecutionIntentBase {
  readonly role: "runtime";
  readonly resources?: Readonly<WorkloadLimits>;
  readonly egress: { readonly mode: "mediated-web"; readonly allowlist?: readonly string[] };
}

/** The role discriminates profile and egress policy before a backend launches. */
export type ExecutionIntent = BuilderExecutionIntent | RuntimeExecutionIntent;

/** Bind-side listener details passed only to a launch adapter. */
export interface ListenerBinding {
  readonly name: string;
  readonly address: string;
}

/** Values a backend prepares before an adapter synchronously chooses its command. */
export interface ExecutionBindings {
  readonly listeners: readonly ListenerBinding[];
  readonly capabilities: readonly CapabilityReference[];
  /** Reserved values override adapter environment values at launch. */
  readonly reservedEnv: Readonly<Record<string, string>>;
}

/** The adapter result a backend launches after applying {@link ExecutionBindings}. */
export interface LaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** A synchronous adapter invoked only after the backend has prepared the sandbox. */
export type ExecutionLaunch = (bindings: ExecutionBindings) => LaunchSpec;

/** Opaque backend handle; callers address a whole sandbox, not a process id. */
export interface ExecutionHandle {
  readonly id: string;
  readonly generation: string;
}

/** Dial-side endpoint published in status; it has no bind credential or host path. */
export interface ExecutionEndpoint {
  readonly name: string;
  readonly address: string;
}

/** Resource usage sampled by a backend. Omitted fields are unavailable, not unlimited. */
export interface ExecutionUsage {
  readonly cpuMillicores?: number;
  readonly memoryBytes?: number;
  readonly pids?: number;
  readonly openFiles?: number;
  readonly scratchBytes?: number;
  readonly scratchInodes?: number;
}

/** The only terminal states a backend may report for a sandbox. */
export type ExecutionClosedReason =
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped"
  | "oom"
  | "pids"
  | "open-files"
  | "disk"
  | "inodes"
  | "deadline";

/** Status of one whole sandbox, including only a backend-bounded tail of its logs. */
interface ExecutionStatusBase {
  readonly handle: ExecutionHandle;
  readonly identity: ExecutionIdentity;
  readonly logTail: readonly string[];
  readonly endpoints: readonly ExecutionEndpoint[];
  readonly usage: ExecutionUsage;
}

/** A sandbox whose lifecycle is still active. */
export interface RunningExecutionStatus extends ExecutionStatusBase {
  readonly state: "running";
  readonly closedReason?: never;
}

/** A sandbox that has fully torn down. */
export interface ClosedExecutionStatus extends ExecutionStatusBase {
  readonly state: "closed";
  readonly closedReason: ExecutionClosedReason;
}

/** Current status always distinguishes active from fully closed sandboxes. */
export type ExecutionStatus = RunningExecutionStatus | ClosedExecutionStatus;

/** Result of a finite task, whose sandbox has already reached a terminal state. */
export interface TaskResult {
  readonly status: ClosedExecutionStatus;
}

/** Stop a sandbox cooperatively or abort it immediately; neither targets a pid. */
export interface ExecutionStopOptions {
  readonly mode: "drain" | "abort";
  readonly graceMs: number;
}

/** Capabilities a secure node needs every selected backend to enforce. */
export interface ExecutionCapabilities {
  readonly isolationModes: readonly ExecutionIsolation[];
  /** Individual opt-in workload limits this backend can enforce. */
  readonly workloadLimits: readonly WorkloadLimitName[];
  readonly features: {
    readonly cancellation: boolean;
    readonly groupTeardown: boolean;
    readonly generationFence: boolean;
    readonly namedListeners: boolean;
    readonly boundedLogs: boolean;
    readonly readOnlyInputs: boolean;
    readonly privateScratch: boolean;
    readonly filesystemIsolation: boolean;
    readonly networkIsolation: boolean;
    readonly protectedNetworkDeny: boolean;
    /** Builder tasks have no egress, independently of runtime mediation. */
    readonly builderEgressDeny: boolean;
    readonly egressMediation: boolean;
    readonly scopedCapabilities: boolean;
    readonly lifecycleLease: boolean;
  };
}

/** The implementation boundary for every secure task and long-lived service. */
export interface ExecutionBackend {
  probe(): Promise<ExecutionCapabilities>;
  runTask(
    intent: BuilderExecutionIntent,
    launch: ExecutionLaunch,
    opts: { signal: AbortSignal },
  ): Promise<TaskResult>;
  startService(
    intent: RuntimeExecutionIntent,
    launch: ExecutionLaunch,
    opts: { signal: AbortSignal },
  ): Promise<ExecutionHandle>;
  list(scope: {
    readonly installationId: string;
    readonly nodeId: string;
  }): Promise<ExecutionHandle[]>;
  inspect(handle: ExecutionHandle): Promise<ExecutionStatus | null>;
  stop(handle: ExecutionHandle, opts: ExecutionStopOptions): Promise<void>;
}

/** Refuses a backend that cannot enforce the full secure execution contract. */
export function assertExecutionBackendCapabilities(capabilities: ExecutionCapabilities): void {
  if (!capabilities.isolationModes.includes("sandbox")) missing("sandbox isolation");
  const labels: Record<keyof ExecutionCapabilities["features"], string> = {
    cancellation: "start cancellation",
    groupTeardown: "whole-sandbox group teardown",
    generationFence: "generation fencing",
    namedListeners: "named listeners",
    boundedLogs: "bounded logs",
    readOnlyInputs: "read-only inputs",
    privateScratch: "private scratch",
    filesystemIsolation: "filesystem isolation",
    networkIsolation: "network isolation",
    protectedNetworkDeny: "protected-network denial",
    builderEgressDeny: "builder egress denial",
    egressMediation: "egress mediation",
    scopedCapabilities: "scoped capabilities",
    lifecycleLease: "lifecycle leases",
  };
  for (const [feature, label] of Object.entries(labels) as [
    keyof ExecutionCapabilities["features"],
    string,
  ][]) {
    if (!capabilities.features[feature]) missing(label);
  }
}

function missing(feature: string): never {
  throw new ScafoError("capability-missing", "Execution backend cannot enforce secure isolation", {
    detail: `The selected backend lacks ${feature}; choose a backend that enforces every secure execution feature`,
  });
}
