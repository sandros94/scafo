import {
  accountCredits,
  type CreditAccount,
  type CreditReservation,
} from "../core/capacity/credits.ts";
import { ScafoError } from "../core/error.ts";
import { assertPositiveSafeInteger } from "../core/utils/number.ts";
import {
  assertDistinct,
  creditOptions,
  duplicate,
  normalizeRequest,
  normalizeRuntime,
} from "./_credit-controller-input.ts";

export const DEFAULT_RUNTIME_CREDIT_MB: number = 512;

/** The node-local credits available to runtime transitions and deploy work. */
export interface CreditControllerOptions {
  allocatableMb: number;
  surgeMb: number;
}

/** A caller-owned namespace prevents process and build identities from colliding. */
export interface CreditOwner {
  namespace: string;
  id: string;
}

/** One named steady-runtime reservation supplied by the reconciled runtime snapshot. */
export interface RuntimeCreditReservation {
  owner: CreditOwner;
  mb: number;
}

/** The input to a synchronous transient reservation attempt. */
export interface CreditReservationRequest {
  owner: CreditOwner;
  mb: number;
}

/** The sole capability that can remove one transient reservation. */
export interface CreditHold {
  release(): void;
}

/** A replaceable node-local credit-accounting implementation. */
export interface CreditController {
  readonly account: Readonly<CreditAccount>;
  /** Runs synchronously after committed credit mutations; returns an idempotent unsubscribe. */
  subscribe(listener: () => void): () => void;
  replaceRuntime(reservations: readonly RuntimeCreditReservation[]): void;
  tryReserveTransition(request: CreditReservationRequest): CreditHold | undefined;
  tryReserveDeploy(request: CreditReservationRequest): CreditHold | undefined;
}

/** Refuses a pool that cannot separately admit protected runtime and deploy work. */
export function assertCreditAdmission(
  credits: CreditController,
  runtimeCreditMb: number,
  deployCreditMb: number,
): void {
  assertPositiveSafeInteger(runtimeCreditMb, "runtimeCreditMb");
  assertPositiveSafeInteger(deployCreditMb, "deployCreditMb");
  const account = credits.account;
  if (account.steadyAvailableMb < runtimeCreditMb || account.deployAvailableMb < deployCreditMb) {
    throw new ScafoError("invalid-input", "Insufficient node credit", {
      detail:
        `the ${String(account.allocatableMb)}MiB credit pool cannot separately admit one ` +
        `${String(runtimeCreditMb)}MiB runtime or one ${String(deployCreditMb)}MiB deploy ` +
        `while preserving the ${String(account.surgeMb)}MiB runtime surge`,
    });
  }
}

/**
 * Creates the synchronous owner of this node's unified MiB reservations.
 *
 * Runtime snapshots are replaced as a whole; transition and deploy reservations
 * remain charged until the returned hold is released.
 */
export function createCreditController(options: CreditControllerOptions): CreditController {
  const base = accountCredits(creditOptions(options));
  let runtime = new Map<string, CreditReservation>();
  const transition = new Map<string, CreditReservation>();
  const deploy = new Map<string, CreditReservation>();
  const listeners = new Set<() => void>();
  let current: Readonly<CreditAccount> = freeze(base);

  const notify = (): void => {
    /* A snapshot makes subscription changes and nested reservations independent
       from this committed mutation. Observers are advisory: accounting is never
       rolled back or reported as failed after it has committed. */
    const snapshot = new Set(listeners);
    for (const listener of snapshot) {
      try {
        listener();
      } catch {
        /* A consumer retry hook cannot invalidate a committed reservation. */
      }
    }
  };

  const accountFor = (
    nextRuntime: ReadonlyMap<string, CreditReservation> = runtime,
    nextTransition: ReadonlyMap<string, CreditReservation> = transition,
    nextDeploy: ReadonlyMap<string, CreditReservation> = deploy,
  ): Readonly<CreditAccount> =>
    freeze(
      accountCredits({
        allocatableMb: base.allocatableMb,
        surgeMb: base.surgeMb,
        runtime: [...nextRuntime.values()],
        transition: [...nextTransition.values()],
        deploy: [...nextDeploy.values()],
      }),
    );

  const reserve = (
    kind: "transition" | "deploy",
    request: CreditReservationRequest,
  ): CreditHold | undefined => {
    const reservation = normalizeRequest(request, kind);
    const key = reservation.target;
    if (runtime.has(key) || transition.has(key) || deploy.has(key)) throw duplicate(key);

    const next = new Map(kind === "transition" ? transition : deploy);
    next.set(key, reservation);
    const candidate =
      kind === "transition"
        ? accountFor(runtime, next, deploy)
        : accountFor(runtime, transition, next);
    const available =
      kind === "transition" ? current.runtimeAvailableMb : current.deployAvailableMb;
    if (available < reservation.mb) return undefined;

    const reservations = kind === "transition" ? transition : deploy;
    reservations.set(key, reservation);
    current = candidate;
    notify();
    let released = false;

    return Object.freeze({
      release(): void {
        if (released || reservations.get(key) !== reservation) {
          throw new ScafoError("invalid-input", "Credit hold was already released");
        }
        const candidate = new Map(reservations);
        candidate.delete(key);
        current =
          kind === "transition"
            ? accountFor(runtime, candidate, deploy)
            : accountFor(runtime, transition, candidate);
        reservations.delete(key);
        released = true;
        notify();
      },
    });
  };

  return {
    get account(): Readonly<CreditAccount> {
      return current;
    },
    subscribe(listener: () => void): () => void {
      if (typeof listener !== "function") {
        throw new ScafoError("invalid-input", "Invalid credit listener", {
          detail: "credit listeners must be functions",
        });
      }
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    replaceRuntime(reservations: readonly RuntimeCreditReservation[]): void {
      const nextRuntime = normalizeRuntime(reservations);
      assertDistinct(nextRuntime, transition);
      assertDistinct(nextRuntime, deploy);
      const candidate = accountFor(nextRuntime);
      runtime = nextRuntime;
      current = candidate;
      notify();
    },
    tryReserveTransition(request: CreditReservationRequest): CreditHold | undefined {
      return reserve("transition", request);
    },
    tryReserveDeploy(request: CreditReservationRequest): CreditHold | undefined {
      return reserve("deploy", request);
    },
  };
}

function freeze(account: CreditAccount): Readonly<CreditAccount> {
  return Object.freeze(account);
}
