import { describe, expect, it } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import {
  createCreditController,
  type CreditController,
  type CreditOwner,
} from "../src/daemon/_credit-controller.ts";

const process = (id: string): CreditOwner => ({ namespace: "process", id });
const build = (id: string): CreditOwner => ({ namespace: "build", id });

describe("node-local credit controller", () => {
  it("conserves reservations across runtime, transition and deploy work", () => {
    const credits = controller();
    credits.replaceRuntime([{ owner: process("shop/prod/current"), mb: 50 }]);
    const transition = credits.tryReserveTransition({ owner: process("shop/prod/next"), mb: 10 });
    const deploy = credits.tryReserveDeploy({ owner: build("shop/prod/next"), mb: 20 });

    expect(transition).toBeDefined();
    expect(deploy).toBeDefined();
    expect(credits.account).toMatchObject({
      runtimeMb: 50,
      transitionMb: 10,
      deployMb: 20,
      usedMb: 80,
      availableMb: 20,
      protectedMb: 10,
      deployAvailableMb: 10,
      runtimeAvailableMb: 20,
    });
  });

  it("refuses deploy at the protected-surge boundary while an equal transition succeeds", () => {
    const credits = controller();
    credits.replaceRuntime([{ owner: process("shop/prod/current"), mb: 70 }]);

    expect(credits.tryReserveDeploy({ owner: build("shop/prod/next"), mb: 20 })).toBeUndefined();
    expect(
      credits.tryReserveTransition({ owner: process("shop/prod/next"), mb: 20 }),
    ).toBeDefined();
    expect(credits.account).toMatchObject({ deployMb: 0, transitionMb: 20, usedMb: 90 });
  });

  it("lets transition work spend only the surge it consumed before deploy admission", () => {
    const credits = controller();
    credits.replaceRuntime([{ owner: process("shop/prod/current"), mb: 50 }]);
    credits.tryReserveTransition({ owner: process("shop/prod/next"), mb: 10 });

    expect(credits.account).toMatchObject({ protectedMb: 10, deployAvailableMb: 30 });
    expect(credits.tryReserveDeploy({ owner: build("shop/prod/next"), mb: 30 })).toBeDefined();
    expect(credits.tryReserveDeploy({ owner: build("shop/prod/another"), mb: 1 })).toBeUndefined();
  });

  it("keeps an already-overcommitted runtime snapshot exact and blocks new admission", () => {
    const credits = controller();
    credits.replaceRuntime([{ owner: process("shop/prod/current"), mb: 120 }]);

    expect(credits.account).toMatchObject({
      runtimeMb: 120,
      usedMb: 120,
      availableMb: 0,
      deficitMb: 20,
      fits: false,
    });
    expect(
      credits.tryReserveTransition({ owner: process("shop/prod/next"), mb: 1 }),
    ).toBeUndefined();
    expect(credits.tryReserveDeploy({ owner: build("shop/prod/next"), mb: 1 })).toBeUndefined();
  });

  it("replaces runtime snapshots atomically and refuses malformed, duplicate and overflowing inputs", () => {
    const credits = controller();
    credits.replaceRuntime([{ owner: process("shop/prod/current"), mb: 50 }]);
    const before = credits.account;

    for (const input of [
      [{ owner: process("shop/prod/next"), mb: 0 }],
      [
        { owner: process("shop/prod/next"), mb: 1 },
        { owner: process("shop/prod/next"), mb: 1 },
      ],
      [{ owner: { namespace: "process", id: "" }, mb: 1 }],
      [
        { owner: process("shop/prod/next"), mb: Number.MAX_SAFE_INTEGER },
        { owner: process("shop/prod/other"), mb: 1 },
      ],
    ]) {
      expect(() => credits.replaceRuntime(input)).toThrow(
        expect.objectContaining({ code: "invalid-input" }),
      );
      expect(credits.account).toEqual(before);
    }
  });

  it("enforces one owner across reservation classes", () => {
    const credits = controller();
    const owner = process("shop/prod/next");
    credits.tryReserveTransition({ owner, mb: 1 });

    expect(() => credits.tryReserveDeploy({ owner, mb: 1 })).toThrow(
      expect.objectContaining({ code: "invalid-input" }),
    );
    expect(() => credits.replaceRuntime([{ owner, mb: 1 }])).toThrow(
      expect.objectContaining({ code: "invalid-input" }),
    );
  });

  it("replaces runtime while non-colliding transition and deploy holds remain live", () => {
    const credits = controller();
    credits.replaceRuntime([{ owner: process("shop/prod/current"), mb: 30 }]);
    const transition = credits.tryReserveTransition({ owner: process("shop/prod/next"), mb: 10 });
    const deploy = credits.tryReserveDeploy({ owner: build("shop/prod/next"), mb: 20 });

    credits.replaceRuntime([{ owner: process("blog/prod/current"), mb: 40 }]);
    expect(credits.account).toMatchObject({ runtimeMb: 40, transitionMb: 10, deployMb: 20 });
    transition?.release();
    deploy?.release();
    expect(credits.account).toMatchObject({ runtimeMb: 40, transitionMb: 0, deployMb: 0 });
  });

  it("rejects malformed reservation identities and amounts with typed errors", () => {
    const credits = controller();
    const before = credits.account;

    for (const request of [
      { owner: { namespace: "", id: "shop/prod/next" }, mb: 1 },
      { owner: { namespace: "process", id: "" }, mb: 1 },
      { owner: process("shop/prod/next"), mb: 0 },
      { owner: process("shop/prod/next"), mb: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => credits.tryReserveTransition(request)).toThrow(
        expect.objectContaining({ code: "invalid-input" }),
      );
      expect(credits.account).toEqual(before);
    }
  });

  it("restores the exact prior account on release and refuses stale or double release", () => {
    const credits = controller();
    credits.replaceRuntime([{ owner: process("shop/prod/current"), mb: 50 }]);
    const before = credits.account;
    const hold = credits.tryReserveDeploy({ owner: build("shop/prod/next"), mb: 20 });
    expect(hold).toBeDefined();

    hold?.release();
    expect(credits.account).toEqual(before);
    expect(() => hold?.release()).toThrow(ScafoError);
    expect(() => hold?.release()).toThrow(expect.objectContaining({ code: "invalid-input" }));
  });

  it("releases transition holds through the transition account", () => {
    const credits = controller();
    credits.replaceRuntime([{ owner: process("shop/prod/current"), mb: 70 }]);
    const before = credits.account;
    const hold = credits.tryReserveTransition({ owner: process("shop/prod/next"), mb: 20 });

    expect(hold).toBeDefined();
    hold?.release();
    expect(credits.account).toEqual(before);
  });

  it("leaves state unchanged when admission is refused", () => {
    const credits = controller();
    credits.replaceRuntime([{ owner: process("shop/prod/current"), mb: 70 }]);
    const before = credits.account;

    expect(credits.tryReserveDeploy({ owner: build("shop/prod/next"), mb: 11 })).toBeUndefined();
    expect(credits.account).toEqual(before);
  });

  it("exposes immutable account snapshots", () => {
    const credits = controller();
    const snapshot = credits.account;

    expect(() => ((snapshot as { usedMb: number }).usedMb = 99)).toThrow(TypeError);
    expect(credits.account).toEqual(snapshot);
  });

  it("returns the same snapshot independent of runtime-reservation input order", () => {
    const first = controller();
    const second = controller();
    const reservations = [
      { owner: process("shop/prod/a"), mb: 30 },
      { owner: process("shop/prod/b"), mb: 20 },
      { owner: process("shop/prod/c"), mb: 10 },
    ];

    first.replaceRuntime(reservations);
    second.replaceRuntime([...reservations].reverse());
    expect(second.account).toEqual(first.account);
  });

  it("normalizes malformed controller options into typed input errors", () => {
    for (const options of [null, [], {}, { allocatableMb: 100, surgeMb: 101 }]) {
      expect(() => createCreditController(options as never)).toThrow(
        expect.objectContaining({ code: "invalid-input" }),
      );
    }
  });
});

function controller(): CreditController {
  return createCreditController({ allocatableMb: 100, surgeMb: 20 });
}
