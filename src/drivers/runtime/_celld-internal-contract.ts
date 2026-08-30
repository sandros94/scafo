/** Configuration for one celld internal-listener client. */
export interface CelldInternalClientOptions {
  /** Portable fetch seam; defaults to the current runtime's global fetch. */
  fetchFn?: typeof fetch;
  /** Whole-call deadline, including response body decoding. */
  timeoutMs?: number;
}

export interface CelldInternalCallOptions {
  /** Cancels the call before its deadline; a typed reason is preserved. */
  signal?: AbortSignal;
}

export interface CelldAdopted {
  outcome: "adopted";
  generation: number;
  version: string;
  prefix: string;
}

export interface CelldUnchanged {
  outcome: "unchanged";
  generation: number;
  version: string;
  /** Absent in celld v0.4; accepted so an additive upstream field is harmless. */
  prefix?: string;
}

export interface CelldAdoptionFailed {
  outcome: "failed";
  version: string;
  prefix: string;
  error: string;
}

export interface CelldReloadUnavailable {
  outcome: "unavailable";
  error: string;
}

export type CelldReloadOutcome =
  | CelldAdopted
  | CelldUnchanged
  | CelldAdoptionFailed
  | CelldReloadUnavailable;

export interface CelldDeploymentState {
  deployment: {
    version: string;
    prefix: string;
    generation: number;
  };
}

export interface CelldActorStoppedState {
  error: "actor_stopped";
}

export type CelldInternalState = CelldDeploymentState | CelldActorStoppedState;

/** Operations available only on one celld process's internal listener. */
export interface CelldInternalClient {
  reload(opts?: CelldInternalCallOptions): Promise<CelldReloadOutcome>;
  state(opts?: CelldInternalCallOptions): Promise<CelldInternalState>;
}

export interface CelldInternalResponse {
  status: number;
  body: unknown;
  method: "GET" | "POST";
  path: "/reload" | "/state";
}
