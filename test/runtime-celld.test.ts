import { describe, expect, it } from "vitest";
import { createCelldDriver, HEALTH_PATH, RESERVED_ENV } from "../src/drivers/runtime/celld.ts";
import type { RuntimeProcess, RuntimeSpecInput } from "../src/core/types/runtime.ts";

const VERSION = "0123456789abcdef";
const PREFIX = "deployments/main/0123456789abcdef";

describe("celld process specs", () => {
  it("owns one stable process per environment", () => {
    const spec = createCelldDriver({ binPath: "/opt/celld" }).processSpec(specInput());
    expect(spec.id).toBe("shop--production");
    expect(spec.command).toBe("/opt/celld");
    expect(spec.args).toContain("bucket/fleets/shop/production");
    expect(spec.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      CELLD_MAX_RSS_MB: "512",
      CELLD_VAR_TOKEN: "secret-token",
    });
  });

  it("refuses caller values reserved for node policy", () => {
    for (const name of RESERVED_ENV) {
      expect(() =>
        createCelldDriver({}).processSpec(specInput({ extraEnv: { [name]: "override" } })),
      ).toThrow(expect.objectContaining({ code: "invalid-input" }));
    }
  });
});

describe("in-place deployment adoption", () => {
  it("confirms the exact adopted generation through state", async () => {
    const calls: string[] = [];
    const driver = createCelldDriver({
      internalFetch: internalFetch(calls, [
        json(200, {
          ok: true,
          outcome: "adopted",
          version: VERSION,
          prefix: PREFIX,
          generation: 2,
        }),
        json(200, { deployment: { version: VERSION, prefix: PREFIX, generation: 2 } }),
      ]),
    });
    await expect(driver.adoptCurrent(process())).resolves.toEqual({
      outcome: "confirmed",
      deployment: { version: VERSION, prefix: PREFIX, generation: 2 },
    });
    expect(calls).toEqual(["POST /reload", "GET /state"]);
  });

  it("returns a conclusive rejection without asking state", async () => {
    const calls: string[] = [];
    const driver = createCelldDriver({
      internalFetch: internalFetch(calls, [
        json(422, { ok: false, outcome: "failed", version: VERSION, prefix: PREFIX, error: "bad" }),
      ]),
    });
    await expect(driver.adoptCurrent(process())).resolves.toEqual({
      outcome: "rejected",
      version: VERSION,
      prefix: PREFIX,
      error: "bad",
    });
    expect(calls).toEqual(["POST /reload"]);
  });

  it("refuses disagreement between reload and state", async () => {
    const driver = createCelldDriver({
      internalFetch: internalFetch(
        [],
        [
          json(200, {
            ok: true,
            outcome: "adopted",
            version: VERSION,
            prefix: PREFIX,
            generation: 2,
          }),
          json(200, { deployment: { version: "different", prefix: PREFIX, generation: 2 } }),
        ],
      ),
    });
    await expect(driver.adoptCurrent(process())).rejects.toMatchObject({
      code: "capability-missing",
    });
  });

  it("reads exact state for a newly started process", async () => {
    const driver = createCelldDriver({
      internalFetch: internalFetch(
        [],
        [json(200, { deployment: { version: VERSION, prefix: PREFIX, generation: 1 } })],
      ),
    });
    await expect(driver.currentDeployment(process())).resolves.toEqual({
      version: VERSION,
      prefix: PREFIX,
      generation: 1,
    });
  });
});

describe("readiness", () => {
  it("requires both celld health and the application", async () => {
    const urls: string[] = [];
    const ready = await createCelldDriver({}).probeReady(process(), {
      attempts: 1,
      fetchFn: async (input) => {
        urls.push(requestUrl(input));
        return new Response(null, { status: 200 });
      },
    });
    expect(ready).toBe(true);
    expect(urls).toEqual([`http://127.0.0.1:42010${HEALTH_PATH}`, "http://127.0.0.1:42010/"]);
  });
});

function specInput(overrides?: Partial<RuntimeSpecInput>): RuntimeSpecInput {
  return {
    project: "shop",
    env: {
      v: 1,
      name: "production",
      prefix: "fleets/shop/production",
      deployment: { revision: 1, deployedAt: "2026-01-01T00:00:00.000Z" },
      domains: [],
      placement: "auto",
      ephemeral: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    vars: { TOKEN: { value: "secret-token", secret: true } },
    ports: { public: 42010, internal: 42011 },
    node: {
      endpoint: "http://store.test",
      region: "us-east-1",
      bucket: "bucket",
      accessKey: "access",
      secretKey: "secret",
      advertiseHost: "127.0.0.1",
    },
    maxRssMb: 512,
    ...overrides,
  };
}

function process(): RuntimeProcess {
  return {
    processId: "shop--production",
    project: "shop",
    env: "production",
    attemptedRevision: 1,
    appliedRevision: 1,
    port: 42010,
    internalPort: 42011,
    ready: true,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function internalFetch(calls: string[], answers: Response[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(requestUrl(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const answer = answers.shift();
    if (answer === undefined) throw new Error("unexpected internal call");
    return answer;
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}
