/*
 * The problem document a failure crosses a process boundary as, and the failure
 * it is read back into.
 *
 * The code is the contract — messages may change, codes may not — and it only
 * means anything if it survives the round trip. A client that re-labelled every
 * failure answer with a code of its own would hand its caller the one thing the
 * API is careful to keep distinguishable, already thrown away.
 */

import { describe, expect, it } from "vitest";
import {
  fromProblem,
  PROBLEM_TYPE_PREFIX,
  type ProblemDetails,
  ScafoError,
  type ScafoErrorCode,
} from "../src/core/error.ts";

/** One code of each kind that matters to a caller, plus the catch-all. */
const CODES: ScafoErrorCode[] = [
  "auth-invalid",
  "trust-mismatch",
  "cas-conflict",
  "not-found",
  "invalid-input",
];

describe("a failure that crossed a process boundary", () => {
  it("comes back as the same code, status, title and detail", () => {
    for (const code of CODES) {
      const original = new ScafoError(code, "Something specific happened", {
        detail: "with specifics attached",
      });

      const returned = fromProblem(original.toProblem());

      expect(returned.code, code).toBe(code);
      expect(returned.status, code).toBe(original.status);
      expect(returned.message, code).toBe(original.message);
      expect(returned.detail, code).toBe(original.detail);
    }
  });

  it("keeps a trust denial apart from an authentication failure", () => {
    /*
     * The distinction a CI job acts on: `trust-mismatch` says the token held up
     * and the project does not admit it, which is a policy to fix, while
     * `auth-invalid` says the token itself did not. Collapsing them is how a
     * caller ends up debugging the wrong half.
     */
    const denied = fromProblem(
      new ScafoError("trust-mismatch", "Trust policy does not admit this token", {
        detail: `"repo:evil/other" is not a trusted subject`,
      }).toProblem(),
    );

    expect(denied.code).toBe("trust-mismatch");
    expect(denied.status).toBe(403);
    expect(denied.toProblem().type).toBe(`${PROBLEM_TYPE_PREFIX}trust-mismatch`);
  });

  it("keeps the status the answer actually carried, over the one the code maps to", () => {
    /* An error thrown with a status of its own renders with it, and reading the
       document back must not quietly move it to the default for its code. */
    const problem: ProblemDetails = {
      type: `${PROBLEM_TYPE_PREFIX}not-found`,
      title: "No such deploy",
      status: 410,
    };

    expect(fromProblem(problem).status).toBe(410);
    expect(fromProblem(problem).detail).toBeUndefined();
  });

  it("takes a code it has never heard of as the generic failure it is", () => {
    /* A newer node naming a code this build does not know is a real thing, and
       not worth crashing a deploy over. */
    for (const type of [`${PROBLEM_TYPE_PREFIX}invented-later`, "https://example.test/oops", ""]) {
      const returned = fromProblem({ type, title: "Something", status: 400 });

      expect(returned.code, type).toBe("invalid-input");
      expect(returned.message, type).toBe("Something");
    }
  });

  it("lets the caller say what an unknown code should be taken as", () => {
    const returned = fromProblem(
      { type: "urn:scafo:invented-later", title: "Something", status: 503 },
      "draining",
    );

    expect(returned.code).toBe("draining");
    expect(returned.status).toBe(503);
  });

  it("never takes an inherited property for a code", () => {
    /* The document comes off the wire, so the lookup has to be on the object's
       own keys: `"toString" in DEFAULT_STATUS` is true, and the status it would
       hand back is a function. */
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const returned = fromProblem({
        type: `${PROBLEM_TYPE_PREFIX}${name}`,
        title: "Something",
        status: 400,
      });

      expect(returned.code, name).toBe("invalid-input");
      expect(typeof returned.status, name).toBe("number");
      expect(JSON.parse(JSON.stringify(returned.toProblem())), name).toEqual({
        type: `${PROBLEM_TYPE_PREFIX}invalid-input`,
        title: "Something",
        status: 400,
      });
    }
  });

  it("survives a body that is not a problem document at all", () => {
    /* What answered may have been a proxy or an error page rather than a node,
       and a client that threw a TypeError over one would report nothing at all
       about the failure it was actually handed. */
    const cases: unknown[] = [
      { type: 502, title: "Bad Gateway", status: 502 },
      { type: null, title: null, status: null },
      { type: `${PROBLEM_TYPE_PREFIX}not-found`, title: "Gone", status: "410" },
      { type: `${PROBLEM_TYPE_PREFIX}not-found`, title: "Gone", status: 410, detail: { a: 1 } },
      {},
    ];

    for (const body of cases) {
      const returned = fromProblem(body as ProblemDetails);

      expect(returned, JSON.stringify(body)).toBeInstanceOf(ScafoError);
      expect(typeof returned.message, JSON.stringify(body)).toBe("string");
      expect(Number.isInteger(returned.status), JSON.stringify(body)).toBe(true);
      expect(
        returned.detail === undefined || typeof returned.detail === "string",
        JSON.stringify(body),
      ).toBe(true);
    }
  });
});
