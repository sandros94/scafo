/* What `scafo health` asks, where it asks it, and what it exits with. */

import type { CommandContext } from "citty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { health, healthUrl, probeHealth } from "../src/cli/commands/health.ts";
import { type DaemonConfig, loadDaemonConfig } from "../src/daemon/config.ts";
import type { DaemonHealth } from "../src/daemon/app.ts";
import { rejectsWith } from "./_helpers.ts";

/** Bucket settings the loader asks for and this suite never reaches. */
const REQUIRED_ENV: Record<string, string> = {
  SCAFO_S3_ENDPOINT: "http://store.test:9000",
  SCAFO_S3_BUCKET: "registry",
  SCAFO_S3_ACCESS_KEY: "key",
  SCAFO_S3_SECRET_KEY: "secret",
};

const SERVING: DaemonHealth = { ok: true, version: "1.2.3", node: "node-a" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  /* Every failure sets it, and a suite that left it set would report the whole
     run as failed. */
  process.exitCode = undefined;
});

describe("where the probe looks", () => {
  it("asks the node's own listener, which is loopback until something moves it", async () => {
    expect(healthUrl(await configuredWith({}))).toBe(
      "http://127.0.0.1:7400/.well-known/scafo/health",
    );
  });

  it("follows the listener onto the tunnel, which is where wireguard puts it", async () => {
    /* The case the fixed-loopback probe reported as unhealthy: nothing names an
       address, and the transport alone moves the listener off loopback. */
    const node = await configuredWith({
      SCAFO_TRANSPORT: "wireguard",
      SCAFO_WG_ADDRESS: "10.83.0.4/24",
      SCAFO_WG_ENDPOINT: "node-a.test:51820",
    });

    expect(node.listen).toBe("10.83.0.4:7400");
    expect(healthUrl(node)).toBe("http://10.83.0.4:7400/.well-known/scafo/health");
  });

  it("follows it onto any address it was told to bind: a plain one, a wildcard, an IPv6", async () => {
    expect(healthUrl(await configuredWith({ SCAFO_LISTEN: "10.0.0.9:9400" }))).toBe(
      "http://10.0.0.9:9400/.well-known/scafo/health",
    );

    /* A wildcard bind is dialled on loopback, because that is one of the
       addresses it answers on. */
    expect(healthUrl(await configuredWith({ SCAFO_LISTEN: "0.0.0.0:7400" }))).toBe(
      "http://127.0.0.1:7400/.well-known/scafo/health",
    );
    expect(healthUrl(await configuredWith({ SCAFO_LISTEN: "[::]:7400" }))).toBe(
      "http://127.0.0.1:7400/.well-known/scafo/health",
    );

    /* And an IPv6 listener is written the way a URL takes one. */
    expect(healthUrl(await configuredWith({ SCAFO_LISTEN: "[fd00::4]:7400" }))).toBe(
      "http://[fd00::4]:7400/.well-known/scafo/health",
    );
  });
});

describe("what the node's answer is taken to mean", () => {
  const URL_ASKED = "http://10.83.0.4:7400/.well-known/scafo/health";

  it("reads the version and the node id back out of a healthy answer", async () => {
    const answer = await probeHealth(URL_ASKED, { fetchFn: answering(SERVING) });

    expect(answer).toEqual(SERVING);
  });

  it("names the address it asked when nothing answered there", async () => {
    const refused = new TypeError("fetch failed", {
      cause: new Error("connect ECONNREFUSED 10.83.0.4:7400"),
    });

    const error = await rejectsWith(
      () => probeHealth(URL_ASKED, { fetchFn: () => Promise.reject(refused) }),
      "not-found",
    );

    expect(error.detail).toContain(URL_ASKED);
    /* What the failure actually was, which `fetch` only puts in the cause. */
    expect(error.detail).toContain("ECONNREFUSED");
  });

  it("refuses a status the node never answers health with", async () => {
    const error = await rejectsWith(
      () =>
        probeHealth(URL_ASKED, {
          fetchFn: () => Promise.resolve(new Response("nope", { status: 502 })),
        }),
      "not-found",
    );

    expect(error.detail).toContain("502");
  });

  it("refuses a 200 that is not the health this node serves", async () => {
    /* A proxy, an error page, or another service on the port: answering at all
       is not the same as being the node. */
    const error = await rejectsWith(
      () => probeHealth(URL_ASKED, { fetchFn: answering({ status: "ok" }) }),
      "not-found",
    );

    expect(error.detail).toContain("200");
  });
});

describe("what the command exits with", () => {
  it("says one line and leaves the exit code alone when the node is serving", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(answering(SERVING));
    const said = capture("log");

    await runHealth({ SCAFO_LISTEN: "0.0.0.0:7400" });

    expect(said()).toEqual([`scafo: healthy 0.0.0.0:7400 (1.2.3) as node "node-a"`]);
    expect(process.exitCode).toBeUndefined();
  });

  it("fails with the listener in the line when the node is not answering", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const said = capture("error");

    await runHealth({ SCAFO_LISTEN: "10.0.0.9:9400" });

    expect(said()).toHaveLength(1);
    expect(said()[0]).toContain("http://10.0.0.9:9400/.well-known/scafo/health");
    expect(process.exitCode).toBe(1);
  });

  it("fails rather than guessing when the configuration it reads is not a node's", async () => {
    const said = capture("error");

    /* Nothing stubbed but the listener: without the bucket the loader has no
       configuration to answer with, and the probe must not invent one. */
    vi.stubEnv("SCAFO_LISTEN", "127.0.0.1:7400");
    await health.run?.({ args: { _: [] }, cmd: health, rawArgs: [] } as unknown as CommandContext);

    expect(said()).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });
});

/** The configuration a node boots from under `env`, with the bucket filled in. */
async function configuredWith(env: Record<string, string>): Promise<DaemonConfig["node"]> {
  const config = await loadDaemonConfig({ env: { ...REQUIRED_ENV, ...env } });
  return config.node;
}

/** Answers every call with `body`, as the node's health endpoint would. */
function answering(body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body)));
}

/** Runs `scafo health` exactly as the binary would, in the environment a node was configured by. */
async function runHealth(env: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries({ ...REQUIRED_ENV, ...env })) {
    vi.stubEnv(name, value);
  }

  await health.run?.({ args: { _: [] }, cmd: health, rawArgs: [] } as unknown as CommandContext);
}

/** Collects what the command wrote on one console stream, one entry per call. */
function capture(stream: "log" | "error"): () => string[] {
  const lines: string[] = [];
  vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  });
  return () => lines;
}
