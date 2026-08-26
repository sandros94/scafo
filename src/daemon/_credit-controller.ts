import {
  accountCredits,
  type CreditAccount,
  type CreditReservation,
} from "../core/capacity/credits.ts";
import { ScafoError } from "../core/error.ts";
import {
  assertDistinct,
  creditOptions,
  duplicate,
  normalizeRequest,
  normalizeRuntime,
} from "./_credit-controller-input.ts";

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
  replaceRuntime(reservations: readonly RuntimeCreditReservation[]): void;
  tryReserveTransition(request: CreditReservationRequest): CreditHold | undefined;
  tryReserveDeploy(request: CreditReservationRequest): CreditHold | undefined;
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
  let current: Readonly<CreditAccount> = freeze(base);

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
      },
    });
  };

  return {
    get account(): Readonly<CreditAccount> {
      return current;
    },
    replaceRuntime(reservations: readonly RuntimeCreditReservation[]): void {
      const nextRuntime = normalizeRuntime(reservations);
      assertDistinct(nextRuntime, transition);
      assertDistinct(nextRuntime, deploy);
      const candidate = accountFor(nextRuntime);
      runtime = nextRuntime;
      current = candidate;
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
