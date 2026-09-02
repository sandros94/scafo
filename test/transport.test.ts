/* Transport classification is required before listeners extend beyond loopback. */

import { describe, expect, it } from "vitest";
import { loadDaemonConfig } from "../src/daemon/config.ts";
import { assertTransportConfigured } from "../src/cli/_bootstrap.ts";
import { isLoopbackHost } from "../src/core/utils/host.ts";
import { rejectionOf, rejectsWith } from "./_helpers.ts";

const REQUIRED_ENV: Record<string, string> = {
  SCAFO_S3_ENDPOINT: "http://store.test:9000",
  SCAFO_S3_BUCKET: "registry",
  SCAFO_S3_ACCESS_KEY: "key",
  SCAFO_S3_SECRET_KEY: "secret",
};

/** Every address that reaches past this machine, one per setting that carries it. */
const EXPOSED: Record<string, Record<string, string>> = {
  "a listener bound to every interface": { SCAFO_LISTEN: "0.0.0.0:7400" },
  "a listener bound to one real interface": { SCAFO_LISTEN: "10.0.0.4:7400" },
  "an internal listener off loopback": {
    SCAFO_LISTEN: "127.0.0.1:7400",
    SCAFO_INTERNAL_LISTEN: "10.0.0.4:7401",
  },
  "an advertised address off loopback": {
    SCAFO_LISTEN: "127.0.0.1:7400",
    SCAFO_ADVERTISE: "node-a.internal:7400",
  },
  /* What a fleet spread over several nodes has to widen for cross-node cell
     traffic, and what puts an unauthenticated peer listener on that network. */
  "runtime processes bound past loopback": {
    SCAFO_LISTEN: "127.0.0.1:7400",
    SCAFO_BIND_HOST: "0.0.0.0",
  },
};

describe("a node that would reach past loopback", () => {
  it("refuses to boot when nothing says what network that is", async () => {
    for (const [what, env] of Object.entries(EXPOSED)) {
      const config = await loadDaemonConfig({ env: { ...REQUIRED_ENV, ...env } });

      const error = await rejectsWith(
        () => Promise.resolve(assertTransportConfigured(config)),
        "invalid-input",
      );
      /* Actionable on its own: what made it necessary, and both ways out. */
      expect(error.detail, what).toContain("--transport wireguard");
      expect(error.detail, what).toContain("--transport none");
    }
  });

  it("names the addresses that made the refusal necessary, and only those", async () => {
    const config = await loadDaemonConfig({
      env: {
        ...REQUIRED_ENV,
        SCAFO_LISTEN: "127.0.0.1:7400",
        SCAFO_INTERNAL_LISTEN: "10.0.0.4:7401",
        SCAFO_ADVERTISE: "10.0.0.4:7401",
      },
    });

    const error = await rejectionOf(() => Promise.resolve(assertTransportConfigured(config)));

    expect(error.detail).toContain("node.internalListen");
    expect(error.detail).toContain("node.advertise");
    expect(error.detail).not.toContain("node.listen ");
  });

  it("names the runtime's bind address when that is what exposed the node", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_LISTEN: "127.0.0.1:7400", SCAFO_BIND_HOST: "0.0.0.0" },
    });

    const error = await rejectionOf(() => Promise.resolve(assertTransportConfigured(config)));

    expect(error.detail).toContain("runtime.bindHost");
    expect(error.detail).not.toContain("node.listen ");
  });

  it("boots once the operator classifies the network, either way", async () => {
    for (const [what, env] of Object.entries(EXPOSED)) {
      for (const driver of ["wireguard", "none"]) {
        const config = await loadDaemonConfig({
          env: { ...REQUIRED_ENV, ...env, SCAFO_TRANSPORT: driver },
        });

        expect(config.transport, `${what} with ${driver}`).toEqual({ driver });
        expect(() => assertTransportConfigured(config)).not.toThrow();
      }
    }
  });
});

describe("a node that stays on this machine", () => {
  it("boots with no transport configured at all", async () => {
    const loopback = [
      {},
      { SCAFO_LISTEN: "127.0.0.1:7400" },
      { SCAFO_LISTEN: "localhost:7400" },
      { SCAFO_LISTEN: "[::1]:7400" },
      { SCAFO_LISTEN: "127.0.0.1:7400", SCAFO_INTERNAL_LISTEN: "127.0.0.1:7401" },
      { SCAFO_LISTEN: "127.0.0.1:7400", SCAFO_ADVERTISE: "127.0.0.53:7400" },
      /* The default, stated: a single node's processes need nothing wider. */
      { SCAFO_LISTEN: "127.0.0.1:7400", SCAFO_BIND_HOST: "127.0.0.1" },
    ];

    for (const env of loopback) {
      const config = await loadDaemonConfig({ env: { ...REQUIRED_ENV, ...env } });

      expect(config.transport).toBeUndefined();
      expect(() => assertTransportConfigured(config), JSON.stringify(env)).not.toThrow();
    }
  });
});

describe("what counts as staying on this machine", () => {
  it("takes loopback for the whole 127.0.0.0/8, localhost and the IPv6 loopback", () => {
    for (const host of [
      "127.0.0.1",
      "127.0.0.53",
      "127.255.255.254",
      "localhost",
      "::1",
      "[::1]",
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("takes a wildcard for what it is: every interface, not just loopback", () => {
    for (const host of ["0.0.0.0", "::", "[::]", "10.0.0.4", "128.0.0.1", "node-a.internal"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe("the transport setting itself", () => {
  it("comes from a flag, the environment or the file, in that order", async () => {
    const configPath = "/etc/scafo/scafo.config.jsonc";
    const readFile = (path: string): Promise<string | null> =>
      Promise.resolve(
        path === configPath ? JSON.stringify({ transport: { driver: "wireguard" } }) : null,
      );

    const fromFlag = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_TRANSPORT: "wireguard" },
      flags: { transport: "none" },
    });
    const fromEnv = await loadDaemonConfig({
      configPath,
      readFile,
      env: { ...REQUIRED_ENV, SCAFO_TRANSPORT: "none" },
    });
    const fromFile = await loadDaemonConfig({ configPath, readFile, env: REQUIRED_ENV });

    expect([fromFlag.transport, fromEnv.transport, fromFile.transport]).toEqual([
      { driver: "none" },
      { driver: "none" },
      { driver: "wireguard" },
    ]);
  });

  it("refuses a transport it does not implement rather than falling back to one", async () => {
    const error = await rejectsWith(
      () => loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_TRANSPORT: "tailscale" } }),
      "invalid-input",
    );

    expect(error.detail).toContain("tailscale");
    expect(error.detail).toContain("wireguard");
    expect(error.detail).toContain("none");
  });

  it("has no default: saying nothing is a distinct answer from saying none", async () => {
    const silent = await loadDaemonConfig({ env: REQUIRED_ENV });
    const explicit = await loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_TRANSPORT: "none" } });

    expect(silent.transport).toBeUndefined();
    expect(explicit.transport).toEqual({ driver: "none" });
  });
});
