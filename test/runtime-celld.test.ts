import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CelldDriverOptions,
  celldStateDirs,
  createCelldDriver,
  OPERATOR_RESERVED_ENV,
} from "../src/drivers/runtime/celld.ts";
import type { PortRange } from "../src/core/placement/ports.ts";
import type { RuntimeSpecInput } from "../src/core/types/runtime.ts";
import { rejectsWith } from "./_helpers.ts";

/** Where a driver built by {@link driverOptions} keeps what it creates. */
const STATE_DIR = "/var/lib/scafo";

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A real directory, removed after the case that asked for one. */
async function scratchState(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scafo-celld-state-"));
  made.push(dir);
  return dir;
}

function driverOptions(overrides?: Partial<CelldDriverOptions>): CelldDriverOptions {
  return { stateDir: STATE_DIR, ...overrides };
}

/** A range away from every other one a machine running these cases may use. */
const RANGE: PortRange = { start: 51_000, end: 51_019 };

/**
 * Port options that bind nothing: a case about what a node REMEMBERS must not
 * depend on which ports the machine running it happens to have free.
 */
function portOptions(overrides?: Partial<CelldDriverOptions>): CelldDriverOptions {
  return {
    stateDir: STATE_DIR,
    portRange: RANGE,
    isFree: (): Promise<boolean> => Promise.resolve(true),
    ...overrides,
  };
}

/** Where one application's ports are written. */
function portsFile(stateDir: string, application: string): string {
  return join(celldStateDirs(stateDir, application).root, "ports.json");
}

describe("celld process specs", () => {
  it("leaves celld shutdown policy upstream-owned and waits beyond its default", () => {
    const driver = createCelldDriver(driverOptions());
    const spec = driver.processSpec(specInput());

    expect(driver.stopGraceMs).toBe(45_000);
    expect(spec.env).not.toHaveProperty("CELLD_SHUTDOWN_TOTAL_MS");
    expect(spec.env).not.toHaveProperty("CELLD_IDLE_EVICT_S");
  });

  it("derives supervisor grace from the operator's celld shutdown bound", () => {
    const operatorEnv = {
      CELLD_SHUTDOWN_TOTAL_MS: "60000",
      CELLD_IDLE_EVICT_S: "900",
    };
    const driver = createCelldDriver(driverOptions({ operatorEnv }));
    operatorEnv.CELLD_SHUTDOWN_TOTAL_MS = "120000";
    const spec = driver.processSpec(specInput());

    expect(driver.stopGraceMs).toBe(65_000);
    expect(spec.env).toMatchObject({
      CELLD_SHUTDOWN_TOTAL_MS: "60000",
      CELLD_IDLE_EVICT_S: "900",
    });
  });

  it.each(["", "0", "-1", "1.5", "unbounded", "2147478648"])(
    "refuses untimable CELLD_SHUTDOWN_TOTAL_MS=%j",
    (value) => {
      expect(() =>
        createCelldDriver(driverOptions({ operatorEnv: { CELLD_SHUTDOWN_TOTAL_MS: value } })),
      ).toThrow(expect.objectContaining({ code: "invalid-input" }));
    },
  );

  it("owns one stable process per application", () => {
    const spec = createCelldDriver(driverOptions({ binPath: "/opt/celld" })).processSpec(
      specInput(),
    );
    expect(spec.id).toBe("shop");
    expect(spec.command).toBe("/opt/celld");
    expect(spec.args).toContain("bucket/fleets/shop");
    expect(spec.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(spec.env).not.toHaveProperty("CELLD_MAX_RSS_MB");
    expect(spec.env).not.toHaveProperty("CELLD_MAX_RESIDENT_CELLS");
  });

  it("hands the process no variables of its own", () => {
    /* An application's variables travel in its deployed configuration, so a
       process is started with none of them in its own process environment. */
    const spec = createCelldDriver(
      driverOptions({ operatorEnv: { CELLD_IDLE_EVICT_S: "900" } }),
    ).processSpec(specInput());

    expect(Object.keys(spec.env ?? {}).filter((name) => name.startsWith("CELLD_VAR_"))).toEqual([]);
  });

  it("passes operator-owned celld policy through unchanged", () => {
    const spec = createCelldDriver(
      driverOptions({
        operatorEnv: {
          CELLD_DURABILITY: "bucket",
          CELLD_IDLE_EVICT_S: "900",
          CELLD_MAX_RSS_MB: "384",
          CELLD_MAX_RESIDENT_CELLS: "12",
        },
      }),
    ).processSpec(specInput());
    expect(spec.env).toMatchObject({
      CELLD_DURABILITY: "bucket",
      CELLD_IDLE_EVICT_S: "900",
      CELLD_MAX_RSS_MB: "384",
      CELLD_MAX_RESIDENT_CELLS: "12",
    });
  });

  it("reserves only the variables it derives itself", () => {
    /* Scafo keeps no list of names upstream has stopped reading: a variable it
       does not derive is the operator's to set, and celld answers for its own. */
    expect(OPERATOR_RESERVED_ENV).not.toContain("CELLD_VARS_FILE");

    const spec = createCelldDriver(
      driverOptions({ operatorEnv: { CELLD_VARS_FILE: "/shared/vars" } }),
    ).processSpec(specInput());
    expect(spec.env).toHaveProperty("CELLD_VARS_FILE", "/shared/vars");
  });

  it("names the process after this node and points it at directories that outlive it", () => {
    /* An acknowledged write a peer holds is recovered at boot by the successor
       OF THE SAME NAME reading the follower disk its predecessor left. Both
       halves are derived here: upstream would otherwise pick a random name and
       a directory under $TMPDIR that is new on every start. */
    const spec = createCelldDriver(driverOptions()).processSpec(specInput());

    expect(spec.env).toMatchObject({
      CELLD_NODE: "node-a",
      CELLD_WATCH: "/var/lib/scafo/celld/shop/work",
      CELLD_ASSET_CACHE_DIR: "/var/lib/scafo/celld/shop/assets",
    });
  });

  it("keeps all three out of the operator's reach, whatever the operator sets", () => {
    const spec = createCelldDriver(
      driverOptions({
        operatorEnv: {
          CELLD_NODE: "whatever",
          CELLD_WATCH: "/tmp/elsewhere",
          CELLD_ASSET_CACHE_DIR: "/tmp/elsewhere",
        },
      }),
    ).processSpec(specInput());

    expect(OPERATOR_RESERVED_ENV).toEqual(
      expect.arrayContaining(["CELLD_NODE", "CELLD_WATCH", "CELLD_ASSET_CACHE_DIR"]),
    );
    expect(spec.env).toMatchObject({
      CELLD_NODE: "node-a",
      CELLD_WATCH: "/var/lib/scafo/celld/shop/work",
      CELLD_ASSET_CACHE_DIR: "/var/lib/scafo/celld/shop/assets",
    });
  });

  it("gives every process of the node its own directories", () => {
    const driver = createCelldDriver(driverOptions());
    const shop = driver.processSpec(specInput());
    const other = driver.processSpec(
      specInput({
        application: { ...specInput().application, name: "shop-preview" },
      }),
    );

    expect(other.env?.CELLD_WATCH).toBe("/var/lib/scafo/celld/shop-preview/work");
    expect(other.env?.CELLD_ASSET_CACHE_DIR).not.toBe(shop.env?.CELLD_ASSET_CACHE_DIR);
  });

  it("refuses to build a path out of a name that is not one path segment", () => {
    expect(() => celldStateDirs(STATE_DIR, "../elsewhere")).toThrow(
      expect.objectContaining({ code: "invalid-slug" }),
    );
  });
});

describe("the local state a celld driver keeps for a node", () => {
  it("creates the directories a process works out of, readable by nobody else", async () => {
    const stateDir = await scratchState();
    const driver = createCelldDriver(driverOptions({ stateDir }));

    await driver.prepareLocalState("shop");

    const dirs = celldStateDirs(stateDir, "shop");
    for (const path of [dirs.root, dirs.work, dirs.assets]) {
      expect((await stat(path)).mode & 0o777, path).toBe(0o700);
    }
  });

  it("leaves a directory a process already worked out of exactly as it was", async () => {
    const stateDir = await scratchState();
    const driver = createCelldDriver(driverOptions({ stateDir }));
    await driver.prepareLocalState("shop");
    const kept = join(celldStateDirs(stateDir, "shop").work, "node.log");
    await writeFile(kept, "acknowledged");

    await driver.prepareLocalState("shop");

    expect(await readdir(celldStateDirs(stateDir, "shop").work)).toEqual(["node.log"]);
  });

  it("holds nothing at all before a process has ever run here", async () => {
    const driver = createCelldDriver(driverOptions({ stateDir: await scratchState() }));

    expect(await driver.heldLocalState()).toEqual([]);
  });

  it("reports what it holds and removes one application's whole directory", async () => {
    const stateDir = await scratchState();
    const driver = createCelldDriver(driverOptions({ stateDir }));
    await driver.prepareLocalState("shop");
    await driver.prepareLocalState("shop-preview");

    expect((await driver.heldLocalState()).sort()).toEqual(["shop", "shop-preview"]);

    await driver.removeLocalState("shop");

    expect(await driver.heldLocalState()).toEqual(["shop-preview"]);
    /* Removing what is already gone is how a retried pass ends. */
    await driver.removeLocalState("shop");
  });

  it("reports nothing for an entry that is no application name", async () => {
    const stateDir = await scratchState();
    const driver = createCelldDriver(driverOptions({ stateDir }));
    await driver.prepareLocalState("shop");
    await writeFile(join(stateDir, "celld", "README"), "not a process directory");

    expect(await driver.heldLocalState()).toEqual(["shop"]);
  });
});

describe("the ports an application holds on a node", () => {
  it("chooses a pair inside the range, writes it down, and hands the same one back", async () => {
    const stateDir = await scratchState();
    const driver = createCelldDriver(portOptions({ stateDir }));

    const first = await driver.ports("shop");
    expect(first.replaced).toBeUndefined();
    expect(first.ports.public).toBeGreaterThanOrEqual(RANGE.start);
    expect(first.ports.internal).toBeLessThanOrEqual(RANGE.end);

    const written = JSON.parse(await readFile(portsFile(stateDir, "shop"), "utf8")) as unknown;
    expect(written).toEqual({ v: 1, public: first.ports.public, internal: first.ports.internal });
    expect((await stat(portsFile(stateDir, "shop"))).mode & 0o777).toBe(0o600);

    expect((await driver.ports("shop")).ports).toEqual(first.ports);
  });

  it("leaves no half-written document behind for a reader to find", async () => {
    const stateDir = await scratchState();
    const driver = createCelldDriver(portOptions({ stateDir }));

    await driver.ports("shop");

    /* Written beside the target and renamed over it, so the directory never
       holds anything but whole documents once a write is done. */
    expect(await readdir(celldStateDirs(stateDir, "shop").root)).toEqual(["ports.json"]);
  });

  it("gives the same application its pair back after a daemon restart", async () => {
    const stateDir = await scratchState();
    const before = await createCelldDriver(portOptions({ stateDir })).ports("shop");

    /* A new driver over the same state directory is what a restarted daemon,
       or a container re-created on the same volume, comes back as. */
    const after = await createCelldDriver(portOptions({ stateDir })).ports("shop");

    expect(after.ports).toEqual(before.ports);
    expect(after.replaced).toBeUndefined();
  });

  it("never gives one application's ports to another, sibling names included", async () => {
    const stateDir = await scratchState();
    const driver = createCelldDriver(portOptions({ stateDir }));
    const held = new Set<number>();

    for (const application of ["shop", "shop-preview", "shop2", "blog"]) {
      const { ports } = await driver.ports(application);
      expect(held.has(ports.public), `${application} reused a public port`).toBe(false);
      expect(held.has(ports.internal), `${application} reused an internal port`).toBe(false);
      held.add(ports.public);
      held.add(ports.internal);
    }
    expect(held.size).toBe(8);
  });

  it("replaces a persisted pair a foreign process took, and says which it replaced", async () => {
    const stateDir = await scratchState();
    const taken = new Set<number>();
    const driver = createCelldDriver(
      portOptions({ stateDir, isFree: (port) => Promise.resolve(!taken.has(port)) }),
    );
    const first = await driver.ports("shop");

    /* Something else on the machine bound the public half while the
       application was stopped: it must not wedge, so a new pair is chosen. */
    taken.add(first.ports.public);
    const second = await driver.ports("shop");

    expect(second.replaced).toEqual(first.ports);
    expect(second.ports).not.toEqual(first.ports);
    expect(second.ports.public).not.toBe(first.ports.public);
    /* And written down, so the next start comes back to the new pair. */
    expect((await createCelldDriver(portOptions({ stateDir })).ports("shop")).ports).toEqual(
      second.ports,
    );
  });

  it("chooses a new pair when the file says nothing a pair could be read from", async () => {
    const stateDir = await scratchState();
    const driver = createCelldDriver(portOptions({ stateDir }));
    await driver.ports("shop");
    await writeFile(portsFile(stateDir, "shop"), "{ truncated");

    const chosen = await driver.ports("shop");

    expect(chosen.ports.public).toBeGreaterThanOrEqual(RANGE.start);
    expect(chosen.replaced).toBeUndefined();
  });

  it("refuses with the range when fewer than two of its ports are free", async () => {
    const stateDir = await scratchState();
    const driver = createCelldDriver(
      portOptions({ stateDir, portRange: { start: 51_000, end: 51_001 } }),
    );
    await driver.ports("shop");

    const error = await rejectsWith(
      async () => await driver.ports("blog"),
      "placement-unavailable",
    );

    expect(error.detail).toContain("51000");
    expect(error.detail).toContain("51001");
  });
});

describe("a pair this node released", () => {
  it("is kept from a different application until the quarantine has run out", async () => {
    const stateDir = await scratchState();
    let clock = 1_000_000;
    const options = portOptions({
      stateDir,
      /* One pair fits this range exactly, so the released pair is the only one
         the second application could ever be given. */
      portRange: { start: 51_000, end: 51_001 },
      portQuarantineMs: 60_000,
      now: () => clock,
    });
    const driver = createCelldDriver(options);
    const released = await driver.ports("shop");
    await driver.prepareLocalState("shop");

    await driver.removeLocalState("shop");

    /* Still routed to by peers and ingresses that have not re-read: refused
       rather than handed over, even though nothing else is left. */
    await rejectsWith(async () => await driver.ports("blog"), "placement-unavailable");

    clock += 60_001;
    const reused = await driver.ports("blog");

    const ascending = (a: number, b: number): number => a - b;
    expect([reused.ports.public, reused.ports.internal].sort(ascending)).toEqual(
      [released.ports.public, released.ports.internal].sort(ascending),
    );
  });

  it("is still quarantined after a daemon restart", async () => {
    const stateDir = await scratchState();
    let clock = 1_000_000;
    const options = portOptions({
      stateDir,
      portRange: { start: 51_000, end: 51_001 },
      portQuarantineMs: 60_000,
      now: () => clock,
    });
    const first = createCelldDriver(options);
    await first.ports("shop");
    await first.removeLocalState("shop");

    const revived = createCelldDriver(options);
    const error = await rejectsWith(
      async () => await revived.ports("blog"),
      "placement-unavailable",
    );
    expect(error.code).toBe("placement-unavailable");

    clock += 60_001;
    expect((await revived.ports("blog")).ports.public).toBeGreaterThanOrEqual(51_000);
  });
});

/*
 * The one question that decides whether a process is published: has it answered
 * for itself? It is asked over a real socket, because what the defect turned on
 * was a port that was open in a node's bookkeeping and closed on the machine.
 */
describe("asking a process whether it is serving", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((settle) => server.close(() => settle()));
    }
  });

  /** A listener on loopback that answers every request with `handle`. */
  async function listening(handle: RequestListener): Promise<number> {
    const server = createServer(handle);
    servers.push(server);
    await new Promise<void>((settle) => server.listen(0, "127.0.0.1", () => settle()));
    return (server.address() as AddressInfo).port;
  }

  /** The port nothing is listening on, so a dial to it is refused at once. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((settle) => server.listen(0, "127.0.0.1", () => settle()));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((settle) => server.close(() => settle()));
    return port;
  }

  it("asks the public port for the health path a Celld process answers on", async () => {
    const asked: Array<{ url: string | undefined; host: string | undefined }> = [];
    const port = await listening((request, response) => {
      asked.push({ url: request.url, host: request.headers.host });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    const driver = createCelldDriver(driverOptions());

    expect(await driver.ready({ application: "shop", host: "127.0.0.1", port })).toBe(true);
    expect(asked).toEqual([
      { url: "/.well-known/celld/health", host: `127.0.0.1:${String(port)}` },
    ]);
  });

  it("takes any 2xx for an answer and nothing else", async () => {
    const driver = createCelldDriver(driverOptions());
    const statuses: Array<[number, boolean]> = [
      [200, true],
      [204, true],
      [404, false],
      [500, false],
      [503, false],
    ];

    for (const [status, ready] of statuses) {
      const port = await listening((_request, response) => {
        response.writeHead(status);
        response.end();
      });
      expect(
        await driver.ready({ application: "shop", host: "127.0.0.1", port }),
        `HTTP ${String(status)}`,
      ).toBe(ready);
    }
  });

  /* The whole point: a spawned process holds its port before anything listens. */
  it("answers no for a refused connection rather than raising", async () => {
    const driver = createCelldDriver(driverOptions());

    expect(
      await driver.ready({ application: "shop", host: "127.0.0.1", port: await closedPort() }),
    ).toBe(false);
  });

  it("answers no for a listener that accepts and never replies, within its own bound", async () => {
    const driver = createCelldDriver(driverOptions());
    const port = await listening(() => {
      /* Accepted, and left hanging: the shape of a process that is up and stuck. */
    });

    const started = performance.now();
    expect(await driver.ready({ application: "shop", host: "127.0.0.1", port })).toBe(false);
    /* Bounded well inside a reconcile interval, so a pass never waits on it. */
    expect(performance.now() - started).toBeLessThan(4000);
  }, 10_000);
});

function specInput(overrides?: Partial<RuntimeSpecInput>): RuntimeSpecInput {
  return {
    application: {
      v: 1,
      name: "shop",
      deployment: { revision: 1, deployedAt: "2026-01-01T00:00:00.000Z" },
      domains: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    ports: { public: 42010, internal: 42011 },
    node: {
      id: "node-a",
      endpoint: "http://store.test",
      region: "us-east-1",
      bucket: "bucket",
      accessKey: "access",
      secretKey: "secret",
      advertiseHost: "127.0.0.1",
    },
    ...overrides,
  };
}
