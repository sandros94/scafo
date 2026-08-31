/*
 * Daemon configuration: which source wins for a setting, what a malformed value
 * costs, and what the loader supplies when nothing configures it.
 *
 * Every input is injected — the file reader, the environment and the flags — so
 * the suite reads no file, no environment variable and no command line.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_JSON_BYTES,
  DEFAULT_BIND_HOST,
  DEFAULT_CELL_IDLE_EVICT_S,
  DEFAULT_DURABILITY,
  DEFAULT_CONFIG_PATHS,
  DEFAULT_LISTEN,
  DEFAULT_REGION,
  type DeployConfig,
  loadDaemonConfig,
  type LoadConfigOptions,
  parseHostPort,
  runtimeDialHost,
} from "../src/daemon/config.ts";
import { DEFAULT_ARCHIVE_ENTRIES, DEFAULT_ARTIFACT_BYTES } from "../src/core/types/deploy.ts";
import {
  DEFAULT_ACTIVE_TASKS,
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_PROJECT_ACTIVE_TASKS,
  DEFAULT_PROJECT_QUEUED_TASKS,
  DEFAULT_PROJECT_STAGED_BYTES,
  DEFAULT_QUEUED_TASKS,
  DEFAULT_QUEUE_TIMEOUT_MS,
  DEFAULT_RECEIVE_TIMEOUT_MS,
  DEFAULT_STAGED_BYTES,
  DEFAULT_TASK_TIMEOUT_MS,
} from "../src/daemon/_deploy-scheduler.ts";
import { rejectionOf, rejectsWith } from "./_helpers.ts";

/** The four settings with no default; every case starts from these. */
const REQUIRED_ENV: Record<string, string> = {
  SCAFO_S3_ENDPOINT: "http://store.test:9000",
  SCAFO_S3_BUCKET: "registry",
  SCAFO_S3_ACCESS_KEY: "key",
  SCAFO_S3_SECRET_KEY: "secret",
};

const CONFIG_PATH = "/etc/scafo/scafo.config.jsonc";

function schedulerValues(config: DeployConfig): number[] {
  return [
    config.activeTasks,
    config.projectActiveTasks,
    config.queuedTasks,
    config.projectQueuedTasks,
    config.stagedBytes,
    config.projectStagedBytes,
    config.receiveTimeoutMs,
    config.queueTimeoutMs,
    config.taskTimeoutMs,
    config.outputBytes,
  ];
}

describe("source precedence", () => {
  it("lets a flag override both the environment and the file", async () => {
    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ bucket: { bucket: "from-file" } })),
      env: { ...REQUIRED_ENV, SCAFO_S3_BUCKET: "from-env" },
      flags: { bucket: "from-flag" },
    });

    expect(config.bucket.bucket).toBe("from-flag");
  });

  it("lets the environment override the file", async () => {
    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ bucket: { bucket: "from-file" } })),
      env: { ...REQUIRED_ENV, SCAFO_S3_BUCKET: "from-env" },
    });

    expect(config.bucket.bucket).toBe("from-env");
  });

  it("falls back to the file when neither a flag nor the environment carries the setting", async () => {
    const file = {
      bucket: {
        endpoint: "http://file.test:9000",
        bucket: "from-file",
        accessKey: "file-key",
        secretKey: "file-secret",
        prefix: "shared/",
      },
      node: { id: "node-from-file", listen: "0.0.0.0:7500" },
    };

    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify(file)),
    });

    expect(config.bucket).toEqual({
      endpoint: "http://file.test:9000",
      region: DEFAULT_REGION,
      bucket: "from-file",
      prefix: "shared/",
      accessKey: "file-key",
      secretKey: "file-secret",
    });
    expect(config.node).toMatchObject({ id: "node-from-file", listen: "0.0.0.0:7500" });
  });

  it("prefers a SCAFO variable to the generic name accepted beside it", async () => {
    const config = await loadDaemonConfig({
      env: {
        ...REQUIRED_ENV,
        S3_ENDPOINT: "http://generic.test:9000",
        AWS_ACCESS_KEY_ID: "generic-key",
        AWS_SECRET_ACCESS_KEY: "generic-secret",
      },
    });

    expect(config.bucket).toMatchObject({
      endpoint: "http://store.test:9000",
      accessKey: "key",
      secretKey: "secret",
    });
  });

  it("accepts the generic bucket variables when no SCAFO name is set", async () => {
    const config = await loadDaemonConfig({
      env: {
        S3_ENDPOINT: "http://generic.test:9000",
        SCAFO_S3_BUCKET: "registry",
        AWS_ACCESS_KEY_ID: "generic-key",
        AWS_SECRET_ACCESS_KEY: "generic-secret",
        AWS_REGION: "eu-west-1",
      },
    });

    expect(config.bucket).toMatchObject({
      endpoint: "http://generic.test:9000",
      region: "eu-west-1",
      accessKey: "generic-key",
      secretKey: "generic-secret",
    });
  });

  it("treats a blank value as unset, whichever source wrote it", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_S3_REGION: "   ", SCAFO_NODE_ID: "" },
      flags: { listen: "  " },
    });

    expect(config.bucket.region).toBe(DEFAULT_REGION);
    expect(config.node.listen).toBe(DEFAULT_LISTEN);
    expect(config.node.id).toBeUndefined();
  });
});

describe("reading the config file", () => {
  it("parses a file written with line and block comments", async () => {
    const jsonc = `{
  // where the registry lives
  "bucket": {
    "endpoint": "http://store.test:9000",
    "bucket": "registry",
    /* credentials for that bucket */
    "accessKey": "key",
    "secretKey": "secret"
  },
  "platformDomains": ["apps.test"]
}`;

    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, jsonc),
    });

    expect(config.bucket.endpoint).toBe("http://store.test:9000");
    expect(config.platformDomains).toEqual(["apps.test"]);
  });

  it("accepts a file with trailing commas, as JSONC allows", async () => {
    const jsonc = `{
  "bucket": {
    "endpoint": "http://store.test:9000",
    "bucket": "registry",
    "accessKey": "key",
    "secretKey": "secret",
  },
}`;

    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, jsonc),
    });

    expect(config.bucket.endpoint).toBe("http://store.test:9000");
    expect(config.bucket.bucket).toBe("registry");
  });

  it("refuses a malformed file instead of ignoring it", async () => {
    const error = await rejectsWith(
      () =>
        loadDaemonConfig({
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, "{ this is not json at all"),
          /* Complete on their own: a tolerated syntax error would load silently. */
          env: REQUIRED_ENV,
        }),
      "invalid-input",
    );

    expect(error.message).toContain("JSONC");
    expect(error.detail).toContain(CONFIG_PATH);
  });

  it("refuses a file that does not hold an object of settings", async () => {
    const error = await rejectsWith(
      () =>
        loadDaemonConfig({
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, '["not", "settings"]'),
          env: REQUIRED_ENV,
        }),
      "invalid-input",
    );

    expect(error.message).toContain("object");
  });

  it("refuses a named file that is not there", async () => {
    const error = await rejectsWith(
      () =>
        loadDaemonConfig({
          configPath: CONFIG_PATH,
          readFile: async (): Promise<null> => null,
          env: REQUIRED_ENV,
        }),
      "invalid-input",
    );

    expect(error.detail).toContain(CONFIG_PATH);
  });

  it("tolerates an absent default file when the other sources are complete", async () => {
    const asked: string[] = [];

    const config = await loadDaemonConfig({
      readFile: async (path: string): Promise<null> => {
        asked.push(path);
        return null;
      },
      env: REQUIRED_ENV,
    });

    expect(asked).toEqual(DEFAULT_CONFIG_PATHS);
    expect(config.bucket.bucket).toBe("registry");
  });

  it("stops at the first default path that can be read", async () => {
    const [, second = ""] = DEFAULT_CONFIG_PATHS;

    const config = await loadDaemonConfig({
      readFile: fileAt(second, JSON.stringify({ bucket: { bucket: "from-second-path" } })),
      env: { ...REQUIRED_ENV, SCAFO_S3_BUCKET: undefined },
    });

    expect(config.bucket.bucket).toBe("from-second-path");
  });
});

describe("required settings", () => {
  it("names the file key, the environment variables and the flag that could supply it", async () => {
    const error = await rejectsWith(() => loadDaemonConfig({ env: {} }), "invalid-input");

    for (const source of ["bucket.endpoint", "SCAFO_S3_ENDPOINT", "S3_ENDPOINT", "--endpoint"]) {
      expect(error.detail, `error detail should mention ${source}`).toContain(source);
    }
  });

  it("reports every required setting the same way", async () => {
    const cases: [string, string[]][] = [
      ["SCAFO_S3_ENDPOINT", ["bucket.endpoint", "--endpoint"]],
      ["SCAFO_S3_BUCKET", ["bucket.bucket", "--bucket"]],
      ["SCAFO_S3_ACCESS_KEY", ["bucket.accessKey", "--access-key"]],
      ["SCAFO_S3_SECRET_KEY", ["bucket.secretKey", "--secret-key"]],
    ];

    for (const [missing, mentions] of cases) {
      const env = { ...REQUIRED_ENV, [missing]: undefined };
      const error = await rejectsWith(() => loadDaemonConfig({ env }), "invalid-input");

      for (const mention of mentions) {
        expect(error.detail, `without ${missing}`).toContain(mention);
      }
    }
  });
});

describe("addresses", () => {
  it("keeps a valid host:port exactly as it was written", async () => {
    const config = await loadDaemonConfig({
      env: {
        ...REQUIRED_ENV,
        SCAFO_LISTEN: "0.0.0.0:7400",
        SCAFO_INTERNAL_LISTEN: "10.0.0.4:7401",
        SCAFO_ADVERTISE: "node4.internal:7401",
      },
    });

    expect(config.node).toMatchObject({
      listen: "0.0.0.0:7400",
      internalListen: "10.0.0.4:7401",
      advertise: "node4.internal:7401",
    });
  });

  it("refuses an unusable address at boot rather than at first use", async () => {
    const invalid = [
      "store.test",
      "store.test:",
      "store.test:0",
      "store.test:99999",
      "store.test:abc",
      ":7400",
      "STORE.test:7400",
      "::1:7400",
    ];
    /* Every address setting is checked, and each names itself in the failure. */
    const settings: [string, string][] = [
      ["SCAFO_LISTEN", "node.listen"],
      ["SCAFO_INTERNAL_LISTEN", "node.internalListen"],
      ["SCAFO_ADVERTISE", "node.advertise"],
    ];

    for (const value of invalid) {
      for (const [variable, field] of settings) {
        const error = await rejectsWith(
          () => loadDaemonConfig({ env: { ...REQUIRED_ENV, [variable]: value } }),
          "invalid-input",
        );

        expect(error.detail, `${variable}=${value}`).toContain(field);
      }
    }
  });

  it("quotes the address it could not parse back to the operator", async () => {
    const error = await rejectsWith(
      () => loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_LISTEN: "store.test" } }),
      "invalid-input",
    );

    expect(error.detail).toContain('got "store.test"');
  });

  it("splits a host:port pair, bracketing an IPv6 literal the way a URL does", () => {
    expect(parseHostPort("127.0.0.1:7400", "node.listen")).toEqual({
      host: "127.0.0.1",
      port: 7400,
    });
    expect(parseHostPort("node4.internal:65535", "node.advertise")).toEqual({
      host: "node4.internal",
      port: 65_535,
    });
    expect(parseHostPort("[::1]:7400", "node.listen")).toEqual({ host: "::1", port: 7400 });
  });

  it("names the field it was asked about when an address is rejected", async () => {
    const error = await rejectionOf(async () => parseHostPort("nonsense", "node.advertise"));

    expect(error.code).toBe("invalid-input");
    expect(error.detail).toContain("node.advertise");
  });
});

describe("platform domains", () => {
  it("splits a comma-separated list, ignoring the spacing around it", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_PLATFORM_DOMAINS: " apps.test, edge.example.com ,," },
    });

    expect(config.platformDomains).toEqual(["apps.test", "edge.example.com"]);
  });

  it("reads a list written as an array in the config file", async () => {
    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ platformDomains: ["apps.test"] })),
      env: REQUIRED_ENV,
    });

    expect(config.platformDomains).toEqual(["apps.test"]);
  });

  it("refuses the whole list when any one host is malformed", async () => {
    const error = await rejectionOf(() =>
      loadDaemonConfig({
        env: { ...REQUIRED_ENV, SCAFO_PLATFORM_DOMAINS: "apps.test,NOT A HOST" },
      }),
    );

    /* A malformed host is reported as the invalid name it is, not as generic input. */
    expect(error.code).toBe("invalid-slug");
    expect(error.detail).toContain("NOT A HOST");
  });

  it("refuses a file list that is not an array of strings", async () => {
    const error = await rejectsWith(
      () =>
        loadDaemonConfig({
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, JSON.stringify({ platformDomains: [1, 2] })),
          env: REQUIRED_ENV,
        }),
      "invalid-input",
    );

    expect(error.detail).toContain("platformDomains");
  });

  it("serves no wildcard domains until one is configured", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.platformDomains).toEqual([]);
  });
});

describe("the labels a node carries", () => {
  it("reads the comma syntax a flag and an environment variable carry", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_NODE_LABELS: " tier=fast, region = eu-west-1 ,," },
    });

    expect(config.node.labels).toEqual({ tier: "fast", region: "eu-west-1" });
  });

  it("reads the object the config file writes them as", async () => {
    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ node: { labels: { tier: "fast" } } })),
      env: REQUIRED_ENV,
    });

    expect(config.node.labels).toEqual({ tier: "fast" });
  });

  it("lets the inline form replace the file's whole set rather than merging into it", async () => {
    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(
        CONFIG_PATH,
        JSON.stringify({ node: { labels: { tier: "slow", gpu: "a100" } } }),
      ),
      env: REQUIRED_ENV,
      flags: { "node-labels": "tier=fast" },
    });

    /* Labels describe one machine: a set half-stated in two places is one
       nobody can read off either of them. */
    expect(config.node.labels).toEqual({ tier: "fast" });
  });

  it("carries none at all when nothing configures them", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.node.labels).toBeUndefined();
  });

  it.each(["tier", "Tier=fast", "tier=FAST", "tier=fast,tier=slow", "=fast"])(
    "refuses %p, naming the setting",
    async (value) => {
      const error = await rejectsWith(
        () => loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_NODE_LABELS: value } }),
        "invalid-input",
      );

      expect(error.detail).toContain("node.labels");
    },
  );

  it.each([{ node: { labels: ["tier=fast"] } }, { node: { labels: { tier: 1 } } }])(
    "refuses a file value that is not an object of labels",
    async (file) => {
      const error = await rejectsWith(
        () =>
          loadDaemonConfig({
            configPath: CONFIG_PATH,
            readFile: fileAt(CONFIG_PATH, JSON.stringify(file)),
            env: REQUIRED_ENV,
          }),
        "invalid-input",
      );

      expect(error.detail).toContain("node.labels");
    },
  );
});

describe("the address runtime processes bind", () => {
  it("keeps runtime processes on loopback until something says otherwise", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    /* The safe half of the setting: a process nothing outside this machine can
       reach is what a single node wants, and is never the wrong answer. */
    expect(config.runtime.bindHost).toBe(DEFAULT_BIND_HOST);
    expect(config.runtime.bindHost).toBe("127.0.0.1");
  });

  it("takes the wildcard addresses a multi-node fleet needs", async () => {
    for (const host of ["0.0.0.0", "::", "10.0.0.4"]) {
      const config = await loadDaemonConfig({
        env: { ...REQUIRED_ENV, SCAFO_BIND_HOST: host },
      });

      expect(config.runtime.bindHost, host).toBe(host);
    }
  });

  it("refuses an address no process could bind", async () => {
    const error = await rejectsWith(
      () => loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_BIND_HOST: "0.0.0.0:8080" } }),
      "invalid-input",
    );

    /* A bare host: the ports come from the allocator, and a pair written here
       would be two sources of truth for what a process listens on. */
    expect(error.detail).toContain("runtime.bindHost");
  });

  /*
   * Where this node DIALS its own processes, derived from where they bind and
   * from nothing else. The ingress takes it from HERE rather than mapping the
   * bind address itself.
   */
  it("dials a wildcard bind on loopback, and every other bind exactly as configured", async () => {
    const dialled = async (bindHost?: string): Promise<string> => {
      const config = await loadDaemonConfig({
        env: bindHost === undefined ? REQUIRED_ENV : { ...REQUIRED_ENV, SCAFO_BIND_HOST: bindHost },
      });
      return runtimeDialHost(config.runtime);
    };

    /* Loopback is among what a wildcard answers on, so a wildcard needs no
       address of its own — and a node that configured nothing binds loopback. */
    await expect(dialled("0.0.0.0")).resolves.toBe("127.0.0.1");
    await expect(dialled("::")).resolves.toBe("127.0.0.1");
    await expect(dialled()).resolves.toBe(DEFAULT_BIND_HOST);
    /* Anything else is taken EXACTLY — a process bound to a tunnel address alone
       answers nothing on loopback, however local the caller is — and `::` is the
       only address here that is not a DNS name or an IPv4 one, so what a dialer
       is handed always writes as a plain authority. */
    await expect(dialled("10.83.0.1")).resolves.toBe("10.83.0.1");
    await expect(dialled("node-a.internal")).resolves.toBe("node-a.internal");
  });
});

describe("when a write counts as durable", () => {
  it("acknowledges against the bucket until the operator trades that away", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    /* The safe half: with every write in the bucket before it is acknowledged,
       losing every node at once still loses nothing. */
    expect(config.runtime.durability).toBe(DEFAULT_DURABILITY);
    expect(config.runtime.durability).toBe("bucket");
  });

  it("takes either mode, from any source, flags first", async () => {
    const fromEnv = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_DURABILITY: "fleet" },
    });
    const flagWins = await loadDaemonConfig({
      flags: { durability: "bucket" },
      env: { ...REQUIRED_ENV, SCAFO_DURABILITY: "fleet" },
    });

    expect(fromEnv.runtime.durability).toBe("fleet");
    expect(flagWins.runtime.durability).toBe("bucket");
  });

  it("refuses a mode the runtime does not have", async () => {
    const error = await rejectsWith(
      () => loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_DURABILITY: "quorum" } }),
      "invalid-input",
    );

    expect(error.detail).toContain("runtime.durability");
    expect(error.detail).toContain('"bucket"');
    expect(error.detail).toContain('"fleet"');
  });
});

describe("how long a cell may sit idle", () => {
  it("evicts on the platform default until the operator says otherwise", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.runtime.cellIdleEvictS).toBe(DEFAULT_CELL_IDLE_EVICT_S);
    expect(config.runtime.cellIdleEvictS).toBe(900);
  });

  it("takes a configured age, and zero for never", async () => {
    const cases: [string, number][] = [
      ["300", 300],
      ["0", 0],
    ];

    for (const [given, expected] of cases) {
      const config = await loadDaemonConfig({
        env: { ...REQUIRED_ENV, SCAFO_CELL_IDLE_EVICT: given },
      });

      expect(config.runtime.cellIdleEvictS, given).toBe(expected);
    }
  });

  it("refuses an age that is not a whole number of seconds", async () => {
    for (const bad of ["-5", "soon", "1.5"]) {
      const error = await rejectsWith(
        () => loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_CELL_IDLE_EVICT: bad } }),
        "invalid-input",
      );

      expect(error.detail, bad).toContain("runtime.cellIdleEvictS");
    }
  });
});

describe("deploy resource limits", () => {
  it("ships finite safeguards for artifact bytes and archive entries", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.deploy).toEqual({
      creditMb: 1024,
      artifactBytes: DEFAULT_ARTIFACT_BYTES,
      archiveEntries: DEFAULT_ARCHIVE_ENTRIES,
      activeTasks: DEFAULT_ACTIVE_TASKS,
      projectActiveTasks: DEFAULT_PROJECT_ACTIVE_TASKS,
      queuedTasks: DEFAULT_QUEUED_TASKS,
      projectQueuedTasks: DEFAULT_PROJECT_QUEUED_TASKS,
      stagedBytes: DEFAULT_STAGED_BYTES,
      projectStagedBytes: DEFAULT_PROJECT_STAGED_BYTES,
      receiveTimeoutMs: DEFAULT_RECEIVE_TIMEOUT_MS,
      queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS,
      taskTimeoutMs: DEFAULT_TASK_TIMEOUT_MS,
      outputBytes: DEFAULT_OUTPUT_BYTES,
    });
  });

  it("takes both limits from flags, environment, or file in precedence order", async () => {
    const file = JSON.stringify({ deploy: { artifactBytes: 10, archiveEntries: 20 } });
    const fromFile = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: REQUIRED_ENV,
    });
    const fromEnv = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: { ...REQUIRED_ENV, SCAFO_ARTIFACT_BYTES: "30", SCAFO_ARCHIVE_ENTRIES: "40" },
    });
    const fromFlags = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: { ...REQUIRED_ENV, SCAFO_ARTIFACT_BYTES: "30", SCAFO_ARCHIVE_ENTRIES: "40" },
      flags: { "artifact-bytes": "50", "archive-entries": "60" },
    });

    expect(
      [fromFile.deploy, fromEnv.deploy, fromFlags.deploy].map((value) => ({
        artifactBytes: value?.artifactBytes,
        archiveEntries: value?.archiveEntries,
      })),
    ).toEqual([
      { artifactBytes: 10, archiveEntries: 20 },
      { artifactBytes: 30, archiveEntries: 40 },
      { artifactBytes: 50, archiveEntries: 60 },
    ]);
  });

  it("refuses zero, negative, fractional, null, infinite, and unsafe limits", async () => {
    for (const [field, env, bad] of [
      ["artifactBytes", "SCAFO_ARTIFACT_BYTES", "0"],
      ["artifactBytes", "SCAFO_ARTIFACT_BYTES", "-1"],
      ["archiveEntries", "SCAFO_ARCHIVE_ENTRIES", "1.5"],
      ["archiveEntries", "SCAFO_ARCHIVE_ENTRIES", "Infinity"],
      ["artifactBytes", "SCAFO_ARTIFACT_BYTES", "9007199254740992"],
    ] as const) {
      const error = await rejectsWith(
        () => loadDaemonConfig({ env: { ...REQUIRED_ENV, [env]: bad } }),
        "invalid-input",
      );
      expect(error.detail).toContain(`deploy.${field}`);
    }

    const nullError = await rejectsWith(
      () =>
        loadDaemonConfig({
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, '{"deploy":{"artifactBytes":null}}'),
          env: REQUIRED_ENV,
        }),
      "invalid-input",
    );
    expect(nullError.detail).toContain("deploy.artifactBytes");
  });

  it("takes every scheduler limit from file, environment, and flags in precedence order", async () => {
    const file = JSON.stringify({
      deploy: {
        artifactBytes: 5,
        activeTasks: 3,
        projectActiveTasks: 2,
        queuedTasks: 6,
        projectQueuedTasks: 3,
        stagedBytes: 1000,
        projectStagedBytes: 800,
        receiveTimeoutMs: 10,
        queueTimeoutMs: 20,
        taskTimeoutMs: 30,
        outputBytes: 40,
      },
    });
    const env = {
      ...REQUIRED_ENV,
      SCAFO_ACTIVE_TASKS: "5",
      SCAFO_PROJECT_ACTIVE_TASKS: "4",
      SCAFO_QUEUED_TASKS: "8",
      SCAFO_PROJECT_QUEUED_TASKS: "6",
      SCAFO_STAGED_BYTES: "2000",
      SCAFO_PROJECT_STAGED_BYTES: "1500",
      SCAFO_RECEIVE_TIMEOUT_MS: "100",
      SCAFO_QUEUE_TIMEOUT_MS: "200",
      SCAFO_TASK_TIMEOUT_MS: "300",
      SCAFO_OUTPUT_BYTES: "400",
    };
    const flags = {
      "active-tasks": "7",
      "project-active-tasks": "6",
      "queued-tasks": "10",
      "project-queued-tasks": "8",
      "staged-bytes": "3000",
      "project-staged-bytes": "2500",
      "receive-timeout-ms": "1000",
      "queue-timeout-ms": "2000",
      "task-timeout-ms": "3000",
      "output-bytes": "4000",
    };
    const fromFile = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: REQUIRED_ENV,
    });
    const fromEnv = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env,
    });
    const fromFlags = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env,
      flags,
    });

    expect(schedulerValues(fromFile.deploy!)).toEqual([3, 2, 6, 3, 1000, 800, 10, 20, 30, 40]);
    expect(schedulerValues(fromEnv.deploy!)).toEqual([5, 4, 8, 6, 2000, 1500, 100, 200, 300, 400]);
    expect(schedulerValues(fromFlags.deploy!)).toEqual([
      7, 6, 10, 8, 3000, 2500, 1000, 2000, 3000, 4000,
    ]);
  });

  it("accepts zero only for queue counts and enforces cross-field bounds", async () => {
    const zero = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_QUEUED_TASKS: "0", SCAFO_PROJECT_QUEUED_TASKS: "0" },
    });
    expect(zero.deploy).toMatchObject({ queuedTasks: 0, projectQueuedTasks: 0 });

    for (const env of [
      { SCAFO_ACTIVE_TASKS: "1", SCAFO_PROJECT_ACTIVE_TASKS: "2" },
      { SCAFO_QUEUED_TASKS: "1", SCAFO_PROJECT_QUEUED_TASKS: "2" },
      { SCAFO_STAGED_BYTES: "1073741824", SCAFO_PROJECT_STAGED_BYTES: "1073741825" },
      { SCAFO_ARTIFACT_BYTES: "100", SCAFO_STAGED_BYTES: "99" },
      { SCAFO_ARTIFACT_BYTES: "100", SCAFO_PROJECT_STAGED_BYTES: "99" },
    ]) {
      await rejectsWith(
        () => loadDaemonConfig({ env: { ...REQUIRED_ENV, ...env } }),
        "invalid-input",
      );
    }
  });
});

describe("memory credit configuration", () => {
  it("ships the selected denominations and resolves file, environment, then flags", async () => {
    const file = JSON.stringify({
      capacity: { memoryFraction: 0.5, daemonOverheadMb: 100 },
      runtime: { creditMb: 200 },
      deploy: { creditMb: 300 },
    });
    const fromFile = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: REQUIRED_ENV,
    });
    const fromEnv = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: {
        ...REQUIRED_ENV,
        SCAFO_MEMORY_FRACTION: "0.6",
        SCAFO_DAEMON_OVERHEAD_MB: "101",
        SCAFO_RUNTIME_CREDIT_MB: "201",
        SCAFO_DEPLOY_CREDIT_MB: "301",
      },
    });
    const fromFlags = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: {
        ...REQUIRED_ENV,
        SCAFO_MEMORY_FRACTION: "0.6",
        SCAFO_DAEMON_OVERHEAD_MB: "101",
        SCAFO_RUNTIME_CREDIT_MB: "201",
        SCAFO_DEPLOY_CREDIT_MB: "301",
      },
      flags: {
        "memory-fraction": "0.7",
        "daemon-overhead-mb": "102",
        "runtime-credit-mb": "202",
        "deploy-credit-mb": "302",
      },
    });

    expect((await loadDaemonConfig({ env: REQUIRED_ENV })).capacity).toEqual({
      memoryFraction: 0.8,
      daemonOverheadMb: 128,
    });
    expect(fromFile).toMatchObject({
      capacity: { memoryFraction: 0.5, daemonOverheadMb: 100 },
      runtime: { creditMb: 200 },
      deploy: { creditMb: 300 },
    });
    expect(fromEnv).toMatchObject({
      capacity: { memoryFraction: 0.6, daemonOverheadMb: 101 },
      runtime: { creditMb: 201 },
      deploy: { creditMb: 301 },
    });
    expect(fromFlags).toMatchObject({
      capacity: { memoryFraction: 0.7, daemonOverheadMb: 102 },
      runtime: { creditMb: 202 },
      deploy: { creditMb: 302 },
    });
  });

  it("refuses invalid credit-pool settings with typed input errors", async () => {
    for (const env of [
      { SCAFO_MEMORY_FRACTION: "0" },
      { SCAFO_MEMORY_FRACTION: "1.01" },
      { SCAFO_MEMORY_FRACTION: "Infinity" },
      { SCAFO_DAEMON_OVERHEAD_MB: "0" },
      { SCAFO_DAEMON_OVERHEAD_MB: "1.5" },
      { SCAFO_RUNTIME_CREDIT_MB: "0" },
      { SCAFO_RUNTIME_CREDIT_MB: "1.5" },
      { SCAFO_DEPLOY_CREDIT_MB: String(Number.MAX_SAFE_INTEGER + 1) },
    ]) {
      await rejectsWith(
        () => loadDaemonConfig({ env: { ...REQUIRED_ENV, ...env } }),
        "invalid-input",
      );
    }
  });
});

describe("JSON request limit", () => {
  it("ships a finite 64 KiB safeguard", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(DEFAULT_JSON_BYTES).toBe(65_536);
    expect(config.api.jsonBytes).toBe(DEFAULT_JSON_BYTES);
  });

  it("takes the limit from flag, environment, or file in precedence order", async () => {
    const file = JSON.stringify({ api: { jsonBytes: 10 } });
    const fromFile = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: REQUIRED_ENV,
    });
    const fromEnv = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: { ...REQUIRED_ENV, SCAFO_JSON_BYTES: "20" },
    });
    const fromFlag = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: { ...REQUIRED_ENV, SCAFO_JSON_BYTES: "20" },
      flags: { "json-bytes": "30" },
    });

    expect([fromFile.api.jsonBytes, fromEnv.api.jsonBytes, fromFlag.api.jsonBytes]).toEqual([
      10, 20, 30,
    ]);
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "unlimited"])(
    "refuses an unusable inline limit: %s",
    async (jsonBytes) => {
      const error = await rejectsWith(
        () =>
          loadDaemonConfig({
            env: { ...REQUIRED_ENV, SCAFO_JSON_BYTES: jsonBytes },
          }),
        "invalid-input",
      );
      expect(error.detail).toContain("api.jsonBytes");
    },
  );

  it("refuses null rather than reading it as absent", async () => {
    const error = await rejectsWith(
      () =>
        loadDaemonConfig({
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, JSON.stringify({ api: { jsonBytes: null } })),
          env: REQUIRED_ENV,
        }),
      "invalid-input",
    );
    expect(error.detail).toContain("api.jsonBytes");
  });
});

describe("the variables an operator hands every runtime process", () => {
  it("reads the comma syntax a flag and an environment variable carry", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_CELLD_ENV: " CELLD_OTEL=1, CELLD_OTEL_SINK = bucket ,," },
    });

    expect(config.runtime.celldEnv).toEqual({ CELLD_OTEL: "1", CELLD_OTEL_SINK: "bucket" });
  });

  it("reads the object the config file writes them as", async () => {
    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(
        CONFIG_PATH,
        JSON.stringify({ runtime: { celldEnv: { CELLD_OTEL: "1", OTEL_HEADERS: "a=1,b=2" } } }),
      ),
      env: REQUIRED_ENV,
    });

    /* The file is where a value carrying a comma goes: the inline form has no
       way to write one, because the separator wins. */
    expect(config.runtime.celldEnv).toEqual({ CELLD_OTEL: "1", OTEL_HEADERS: "a=1,b=2" });
  });

  it("keeps everything after the first equals sign as the value", async () => {
    const config = await loadDaemonConfig({
      flags: { "celld-env": "CELLD_OTEL_RESOURCE=service.name=shop" },
      env: REQUIRED_ENV,
    });

    expect(config.runtime.celldEnv).toEqual({ CELLD_OTEL_RESOURCE: "service.name=shop" });
  });

  it("lets the inline form replace the file's whole set rather than merging into it", async () => {
    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(
        CONFIG_PATH,
        JSON.stringify({ runtime: { celldEnv: { CELLD_OTEL: "0", RUST_BACKTRACE: "1" } } }),
      ),
      env: { ...REQUIRED_ENV, SCAFO_CELLD_ENV: "CELLD_OTEL=1" },
      flags: { "celld-env": "CELLD_OTEL=1,RUST_LOG=debug" },
    });

    /* One process's environment is read off one place, and a flag beats the
       variable beats the file exactly as every other setting does. */
    expect(config.runtime.celldEnv).toEqual({ CELLD_OTEL: "1", RUST_LOG: "debug" });
  });

  it("hands over none at all when nothing configures them", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.runtime.celldEnv).toBeUndefined();
  });

  it("REFUSES a name the runtime driver writes itself, naming the variable", async () => {
    for (const name of ["CELLD_DURABILITY", "AWS_REGION", "CELLD_ADDR", "CELLD_IDLE_EVICT_S"]) {
      const error = await rejectsWith(
        () => loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_CELLD_ENV: `${name}=1` } }),
        "invalid-input",
      );

      /* Refused where it is written rather than at the process that would
         overwrite it: this is the last moment the operator is still looking at
         the configuration they got wrong. */
      expect(error.detail, name).toContain(name);
      expect(error.detail, name).toContain("runtime.celldEnv");
      expect(error.detail, name).toContain("runtime.durability");
      expect(error.detail, name).toContain("runtime.cellIdleEvictS");
    }
  });

  it.each(["CELLD_MAX_RSS_MB", "CELLD_VARS_FILE"])(
    "refuses reserved %s written in the config file",
    async (name) => {
      const error = await rejectsWith(
        () =>
          loadDaemonConfig({
            configPath: CONFIG_PATH,
            readFile: fileAt(
              CONFIG_PATH,
              JSON.stringify({ runtime: { celldEnv: { [name]: "unsafe" } } }),
            ),
            env: REQUIRED_ENV,
          }),
        "invalid-input",
      );

      expect(error.detail).toContain(name);
      expect(error.detail).toContain("runtime.celldEnv");
    },
  );

  it.each(["CELLD_OTEL", "=1", "9LIVES=1", "CELLD-OTEL=1", "CELLD OTEL=1", "A=1,A=2", " , "])(
    "refuses %p, naming the setting",
    async (value) => {
      const error = await rejectsWith(
        () => loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_CELLD_ENV: value } }),
        "invalid-input",
      );

      expect(error.detail).toContain("runtime.celldEnv");
    },
  );

  it.each([
    { runtime: { celldEnv: ["CELLD_OTEL=1"] } },
    { runtime: { celldEnv: { CELLD_OTEL: 1 } } },
    { runtime: { celldEnv: { "celld otel": "1" } } },
  ])("refuses a file value that is not an object of variables", async (file) => {
    const error = await rejectsWith(
      () =>
        loadDaemonConfig({
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, JSON.stringify(file)),
          env: REQUIRED_ENV,
        }),
      "invalid-input",
    );

    expect(error.detail).toContain("runtime.celldEnv");
  });
});

describe("whether the node reports on itself", () => {
  it("is OFF when nothing turns it on", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    /* The default that costs nothing: no ring, no events, and no telemetry
       variable reaching a runtime process. */
    expect(config.observability).toEqual({ enabled: false });
    expect(config.runtime.celldEnv).toBeUndefined();
  });

  it("is turned on from a flag, the environment or the file alike", async () => {
    const fromFlag = await loadDaemonConfig({
      env: REQUIRED_ENV,
      flags: { observability: "true" },
    });
    const fromEnv = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: "1" },
    });
    const fromFile = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ observability: { enabled: true } })),
      env: REQUIRED_ENV,
    });

    expect([fromFlag, fromEnv, fromFile].map((config) => config.observability.enabled)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("lets a flag override the environment and the environment the file", async () => {
    const file = JSON.stringify({ observability: { enabled: true } });

    const overriddenByEnv = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: "0" },
    });
    const overriddenByFlag = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: "0" },
      flags: { observability: "true" },
    });

    expect(overriddenByEnv.observability.enabled).toBe(false);
    expect(overriddenByFlag.observability.enabled).toBe(true);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    [" True ", true],
    ["0", false],
    ["false", false],
    ["FALSE", false],
  ])("reads %p as %p", async (written, expected) => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: written },
    });

    expect(config.observability.enabled).toBe(expected);
  });

  it.each(["yes", "on", "2", "enabled", "off"])(
    "REFUSES %p rather than reading it as off",
    async (written) => {
      const error = await rejectsWith(
        () => loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: written } }),
        "invalid-input",
      );

      /* A switch silently off is the failure this whole surface exists to
         avoid: `SCAFO_OBSERVABILITY=yes` is a node its operator believes is
         reporting. The refusal names the setting and both spellings. */
      expect(error.detail, written).toContain("observability.enabled");
      expect(error.detail, written).toContain(`"1"`);
      expect(error.detail, written).toContain(`"0"`);
    },
  );

  it("refuses a file value that is neither a boolean nor one of those words", async () => {
    const error = await rejectsWith(
      () =>
        loadDaemonConfig({
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, JSON.stringify({ observability: { enabled: 1 } })),
          env: REQUIRED_ENV,
        }),
      "invalid-input",
    );

    expect(error.detail).toContain("observability.enabled");
  });
});

describe("whether the fleet's API answers at the platform apexes", () => {
  it("is ON when nothing says otherwise", async () => {
    /* The apex answered nothing before this existed — no route, no certificate
       — so there is no behaviour to preserve and every installation gains one
       name its tooling can reach any node at. */
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.api).toEqual({ public: true, jsonBytes: DEFAULT_JSON_BYTES });
  });

  it("is turned off from a flag, the environment or the file alike", async () => {
    const fromFlag = await loadDaemonConfig({
      env: REQUIRED_ENV,
      /* `--no-api-public`, as the parser hands it over. */
      flags: { "api-public": "false" },
    });
    const fromEnv = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_API_PUBLIC: "0" },
    });
    const fromFile = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ api: { public: false } })),
      env: REQUIRED_ENV,
    });

    expect([fromFlag, fromEnv, fromFile].map((config) => config.api.public)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("lets a flag override the environment and the environment the file", async () => {
    const file = JSON.stringify({ api: { public: false } });

    const overriddenByEnv = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: { ...REQUIRED_ENV, SCAFO_API_PUBLIC: "1" },
    });
    const overriddenByFlag = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: { ...REQUIRED_ENV, SCAFO_API_PUBLIC: "1" },
      flags: { "api-public": "false" },
    });

    expect(overriddenByEnv.api.public).toBe(true);
    expect(overriddenByFlag.api.public).toBe(false);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    [" True ", true],
    ["0", false],
    ["false", false],
    ["FALSE", false],
  ])("reads %p as %p", async (written, expected) => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_API_PUBLIC: written },
    });

    expect(config.api.public).toBe(expected);
  });

  it.each(["yes", "no", "on", "off", "2", "public"])(
    "REFUSES %p rather than reading it either way",
    async (written) => {
      const error = await rejectsWith(
        () => loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_API_PUBLIC: written } }),
        "invalid-input",
      );

      /* The same refusal the observability switch makes, and for the same
         reason: a value nobody parses read as a default is an operator who
         believes their apex is closed — or open — and is wrong. */
      expect(error.detail, written).toContain("api.public");
      expect(error.detail, written).toContain(`"1"`);
      expect(error.detail, written).toContain(`"0"`);
    },
  );

  it("refuses a file value that is neither a boolean nor one of those words", async () => {
    const error = await rejectsWith(
      () =>
        loadDaemonConfig({
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, JSON.stringify({ api: { public: 1 } })),
          env: REQUIRED_ENV,
        }),
      "invalid-input",
    );

    expect(error.detail).toContain("api.public");
  });
});

describe("the ingress access log the node counts requests off", () => {
  it("is ABSENT unless an operator names one, and that is not a warning", async () => {
    /* Application requests bypass the node API, so per-request numbers can only
       come off the ingress's own log — and where that is, or whether there is
       one at all, is the operator's to say. There is no default to guess. */
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: "1" },
    });

    expect(config.observability).toEqual({ enabled: true });
    expect(config.observability.ingressAccessLog).toBeUndefined();
  });

  it("is named from a flag, the environment or the file alike", async () => {
    const path = "/var/log/scafo-ingress/access.log";

    const fromFlag = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: "1" },
      flags: { "ingress-access-log": path },
    });
    const fromEnv = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: "1", SCAFO_INGRESS_ACCESS_LOG: path },
    });
    const fromFile = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(
        CONFIG_PATH,
        JSON.stringify({ observability: { enabled: true, ingressAccessLog: path } }),
      ),
      env: REQUIRED_ENV,
    });

    expect(
      [fromFlag, fromEnv, fromFile].map((config) => config.observability.ingressAccessLog),
    ).toEqual([path, path, path]);
  });

  it("lets a flag override the environment and the environment the file", async () => {
    const file = JSON.stringify({
      observability: { enabled: true, ingressAccessLog: "/from/file.log" },
    });

    const overriddenByEnv = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: { ...REQUIRED_ENV, SCAFO_INGRESS_ACCESS_LOG: "/from/env.log" },
    });
    const overriddenByFlag = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, file),
      env: { ...REQUIRED_ENV, SCAFO_INGRESS_ACCESS_LOG: "/from/env.log" },
      flags: { "ingress-access-log": "/from/flag.log" },
    });

    expect(overriddenByEnv.observability.ingressAccessLog).toBe("/from/env.log");
    expect(overriddenByFlag.observability.ingressAccessLog).toBe("/from/flag.log");
  });

  it("REFUSES one named while observability is off, in every source", async () => {
    /* A file nothing would ever open is an operator who believes they are
       counting requests and is not — the same silent-off failure the switch
       above refuses, one layer out. */
    for (const opts of [
      { env: { ...REQUIRED_ENV, SCAFO_INGRESS_ACCESS_LOG: "/var/log/access.log" } },
      {
        env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: "0" },
        flags: { "ingress-access-log": "/var/log/access.log" },
      },
      {
        configPath: CONFIG_PATH,
        readFile: fileAt(
          CONFIG_PATH,
          JSON.stringify({ observability: { ingressAccessLog: "/var/log/access.log" } }),
        ),
        env: REQUIRED_ENV,
      },
    ]) {
      const error = await rejectsWith(() => loadDaemonConfig(opts), "invalid-input");

      /* Names both settings and the way forward, because a refusal that only
         restates its rule sends an operator looking for documentation. */
      expect(error.detail).toContain("observability.ingressAccessLog");
      expect(error.detail).toContain("observability.enabled");
      expect(error.detail).toContain("--ingress-access-log");
      expect(error.detail).toContain("/var/log/access.log");
    }
  });

  it("is accepted the moment observability is turned on in ANY source", async () => {
    /* The two need not come from the same place: a file that turns observability
       on and an environment that names the log is a working node. */
    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ observability: { enabled: true } })),
      env: { ...REQUIRED_ENV, SCAFO_INGRESS_ACCESS_LOG: "/var/log/access.log" },
    });

    expect(config.observability).toEqual({
      enabled: true,
      ingressAccessLog: "/var/log/access.log",
    });
  });
});

describe("the runtime telemetry switch the node's own composes", () => {
  it("defaults CELLD_OTEL=1 under the operator's own set when it is on", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: "1", SCAFO_CELLD_ENV: "RUST_LOG=debug" },
    });

    /* A node observing itself runs a runtime that is: the variable is the only
       way that switch reaches a process, and nothing else can carry it. */
    expect(config.runtime.celldEnv).toEqual({ RUST_LOG: "debug", CELLD_OTEL: "1" });
  });

  it("supplies the whole set when the operator handed over none", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: "1" },
    });

    expect(config.runtime.celldEnv).toEqual({ CELLD_OTEL: "1" });
  });

  it("LOSES to an operator who states it, in either direction", async () => {
    const turnedOff = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: "1", SCAFO_CELLD_ENV: "CELLD_OTEL=0" },
    });
    const tuned = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(
        CONFIG_PATH,
        JSON.stringify({ runtime: { celldEnv: { CELLD_OTEL: "2", CELLD_OTEL_SINK: "bucket" } } }),
      ),
      env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: "1" },
    });

    /* The escape hatch stays the escape hatch: the default only ever fills a
       gap, and an operator who turned the runtime's telemetry off while the
       daemon reports on itself has stated something the node does not overrule. */
    expect(turnedOff.runtime.celldEnv).toEqual({ CELLD_OTEL: "0" });
    expect(tuned.runtime.celldEnv).toEqual({ CELLD_OTEL: "2", CELLD_OTEL_SINK: "bucket" });
  });

  it("adds nothing at all while the switch is off", async () => {
    const bare = await loadDaemonConfig({ env: REQUIRED_ENV });
    const configured = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_CELLD_ENV: "RUST_LOG=debug" },
    });

    expect(bare.runtime.celldEnv).toBeUndefined();
    expect(configured.runtime.celldEnv).toEqual({ RUST_LOG: "debug" });
  });
});

describe("node identity and defaults", () => {
  it("falls back to a loopback listener, the default signing region and no extra addresses", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.bucket.region).toBe(DEFAULT_REGION);
    expect(config.bucket.region).toBe("us-east-1");
    expect(config.node.listen).toBe(DEFAULT_LISTEN);
    expect(config.node.listen).toBe("127.0.0.1:7400");
    expect(config.node.internalListen).toBeUndefined();
    expect(config.node.advertise).toBeUndefined();
    expect(config.bucket.prefix).toBeUndefined();
  });

  it("invents no node id, leaving the one the node persisted to stand", async () => {
    /* An id is half of an identity, the key that speaks for it being the other:
       inventing one here would hand a node a different identity on every boot,
       so an unconfigured id is left unset and the node's state directory
       supplies it. */
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.node.id).toBeUndefined();
    expect(config.node.stateDir).toBeUndefined();
  });

  it("keeps a configured node id, which pins the identity the node keeps", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_NODE_ID: "node_west-1" },
    });

    expect(config.node.id).toBe("node_west-1");
  });

  it("takes the state directory from a flag, the environment or the file", async () => {
    const fromFlag = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_STATE_DIR: "/from/env" },
      flags: { "state-dir": "/from/flag" },
    });
    const fromEnv = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ node: { stateDir: "/from/file" } })),
      env: { ...REQUIRED_ENV, SCAFO_STATE_DIR: "/from/env" },
    });
    const fromFile = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ node: { stateDir: "/from/file" } })),
      env: REQUIRED_ENV,
    });

    expect([fromFlag.node.stateDir, fromEnv.node.stateDir, fromFile.node.stateDir]).toEqual([
      "/from/flag",
      "/from/env",
      "/from/file",
    ]);
  });

  it("refuses a node id that could not address a registry record", async () => {
    for (const id of ["NODE-1", "node/1", "node 1", "node.1", "n".repeat(129)]) {
      const error = await rejectionOf(() =>
        loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_NODE_ID: id } }),
      );

      expect(error.code, `for node id "${id}"`).toBe("invalid-slug");
    }
  });
});

describe("which ingress the node drives", () => {
  it("leaves the ingress off when nothing says there is one", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.ingress).toBeUndefined();
  });

  it("reads a Caddy admin API on its own as asking for Caddy", async () => {
    /* The setting predates there being a choice, and a configuration that
       already worked must go on working without naming a driver. */
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_CADDY_ADMIN: "http://127.0.0.1:2019" },
    });

    expect(config.ingress).toEqual({ driver: "caddy", adminUrl: "http://127.0.0.1:2019" });
  });

  it("takes Traefik by name, and needs nothing else to reach it", async () => {
    /* Nothing else, because there is nothing to reach: Traefik polls the daemon
       rather than being called by it. */
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_INGRESS_DRIVER: "traefik" },
    });

    expect(config.ingress).toEqual({ driver: "traefik" });
  });

  it("REFUSES a Caddy setting alongside a driver that has no admin API", async () => {
    for (const [variable, value] of [
      ["SCAFO_CADDY_ADMIN", "http://127.0.0.1:2019"],
      ["SCAFO_CADDY_SERVER", "scafo"],
    ]) {
      const error = await rejectionOf(() =>
        loadDaemonConfig({
          env: { ...REQUIRED_ENV, SCAFO_INGRESS_DRIVER: "traefik", [variable]: value },
        }),
      );

      /* Refused rather than ignored: an operator who wrote both has misread
         which of the two applies, and dropping half of it silently leaves a node
         routing through an ingress they did not think they had selected. The
         refusal names both sides of the mismatch. */
      expect(error.code, variable).toBe("invalid-input");
      expect(error.detail, variable).toContain("traefik");
      expect(error.detail, variable).toContain(value);
    }
  });

  it("refuses an ingress nothing implements, listing the ones that are", async () => {
    const error = await rejectionOf(() =>
      loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_INGRESS_DRIVER: "nginx" } }),
    );

    expect(error.code).toBe("invalid-input");
    expect(error.detail).toContain(`"caddy"`);
    expect(error.detail).toContain(`"traefik"`);
  });

  it("lets a flag pick the driver over what the file says", async () => {
    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ ingress: { driver: "caddy" } })),
      env: REQUIRED_ENV,
      flags: { "ingress-driver": "traefik" },
    });

    expect(config.ingress).toEqual({ driver: "traefik" });
  });
});

describe("the Traefik entryPoints the routers attach to", () => {
  const TRAEFIK_ENV: Record<string, string> = { ...REQUIRED_ENV, SCAFO_INGRESS_DRIVER: "traefik" };

  it("reads a comma-separated list from the environment", async () => {
    const config = await loadDaemonConfig({
      env: { ...TRAEFIK_ENV, SCAFO_TRAEFIK_ENTRYPOINTS: "web, websecure" },
    });

    expect(config.ingress).toEqual({ driver: "traefik", entryPoints: ["web", "websecure"] });
  });

  it("lets a flag override what the environment names", async () => {
    const config = await loadDaemonConfig({
      env: { ...TRAEFIK_ENV, SCAFO_TRAEFIK_ENTRYPOINTS: "web" },
      flags: { "traefik-entrypoints": "websecure" },
    });

    expect(config.ingress).toEqual({ driver: "traefik", entryPoints: ["websecure"] });
  });

  it("reads the array the file carries, which is what the text parses into", async () => {
    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(
        CONFIG_PATH,
        JSON.stringify({ ingress: { driver: "traefik", entryPoints: ["websecure"] } }),
      ),
      env: REQUIRED_ENV,
    });

    expect(config.ingress).toEqual({ driver: "traefik", entryPoints: ["websecure"] });
  });

  it("leaves them absent when nothing names any, so the driver's default applies", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_INGRESS_DRIVER: "traefik" },
    });

    expect(config.ingress?.entryPoints).toBeUndefined();
  });

  it("refuses a list that names nothing, because Traefik reads it as everything", async () => {
    /* Routers with no entryPoints attach to EVERY entryPoint Traefik has —
       including a TLS listener scafo holds no certificate for — so a mistyped
       list must fail the boot rather than claim the whole surface. */
    const error = await rejectionOf(() =>
      loadDaemonConfig({
        env: { ...REQUIRED_ENV, SCAFO_INGRESS_DRIVER: "traefik", SCAFO_TRAEFIK_ENTRYPOINTS: " , " },
      }),
    );

    expect(error.code).toBe("invalid-input");
    expect(error.detail).toContain("ingress.entryPoints");
  });

  it("REFUSES them alongside Caddy, which has no entryPoints to attach to", async () => {
    /* The mirror of the Caddy-setting refusal: an operator who wrote a Traefik
       setting under Caddy has misread which ingress applies, and dropping it
       silently leaves a node routing through one they did not select. */
    for (const env of [
      { SCAFO_TRAEFIK_ENTRYPOINTS: "websecure" },
      {
        SCAFO_INGRESS_DRIVER: "caddy",
        SCAFO_CADDY_ADMIN: "http://127.0.0.1:2019",
        SCAFO_TRAEFIK_ENTRYPOINTS: "websecure",
      },
    ]) {
      const error = await rejectionOf(() => loadDaemonConfig({ env: { ...REQUIRED_ENV, ...env } }));

      expect(error.code).toBe("invalid-input");
      expect(error.detail).toContain("caddy");
      expect(error.detail).toContain("websecure");
    }
  });
});

describe("the tokens guarding the storage surface", () => {
  it("reads the comma-separated list an operator shares with their ingress", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_STORAGE_TOKEN: " new-token , old-token " },
    });

    /* Trimmed, and in the order they were written: the first is the one the node
       materializes for every consumer that reads the file. */
    expect(config.storage).toEqual({ token: ["new-token", "old-token"] });
  });

  it("lets a flag override what the environment names", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_STORAGE_TOKEN: "from-env" },
      flags: { "storage-token": "from-flag" },
    });

    expect(config.storage).toEqual({ token: ["from-flag"] });
  });

  it("takes a plain string or an array from the file, the array carrying entries whole", async () => {
    const asString = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ storage: { token: "new,old" } })),
      env: REQUIRED_ENV,
    });
    const asArray = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(
        CONFIG_PATH,
        JSON.stringify({ storage: { token: [" new ", "with,comma"] } }),
      ),
      env: REQUIRED_ENV,
    });

    expect(asString.storage).toEqual({ token: ["new", "old"] });
    /* The escape hatch for a value the separator would otherwise split. */
    expect(asArray.storage).toEqual({ token: ["new", "with,comma"] });
  });

  it("leaves the node minting its own when nothing names any", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.storage).toBeUndefined();
  });

  it("refuses a value that is there and holds nothing, rather than quietly minting", async () => {
    /* An unset variable in a compose file expands to this. Read as "unset" it
       would mint a token nothing else on the host knows, and every call the
       operator's ingress makes would be refused for reasons neither says. */
    const written: Array<[string, LoadConfigOptions]> = [
      ["an empty variable", { env: { ...REQUIRED_ENV, SCAFO_STORAGE_TOKEN: "" } }],
      ["an empty flag", { env: REQUIRED_ENV, flags: { "storage-token": "" } }],
      [
        "an empty string in the file",
        {
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, JSON.stringify({ storage: { token: "" } })),
          env: REQUIRED_ENV,
        },
      ],
      [
        "an empty array in the file",
        {
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, JSON.stringify({ storage: { token: [] } })),
          env: REQUIRED_ENV,
        },
      ],
    ];

    for (const [label, opts] of written) {
      const error = await rejectionOf(() => loadDaemonConfig(opts));

      expect(error.code, label).toBe("invalid-input");
      expect(error.detail, label).toContain("storage.token");
    }
  });

  it("refuses an entry holding nothing, whichever spelling carried it", async () => {
    for (const written of ["a,,b", " , ", "a,  "]) {
      const error = await rejectionOf(() =>
        loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_STORAGE_TOKEN: written } }),
      );

      expect(error.code, written).toBe("invalid-input");
      expect(error.detail, written).toContain("storage.token");
    }

    const inFile = await rejectionOf(() =>
      loadDaemonConfig({
        configPath: CONFIG_PATH,
        readFile: fileAt(CONFIG_PATH, JSON.stringify({ storage: { token: ["a", "  "] } })),
        env: REQUIRED_ENV,
      }),
    );

    expect(inFile.code).toBe("invalid-input");
    expect(inFile.detail).toContain("storage.token");
  });

  it("refuses a value that is neither a token nor a list of them", async () => {
    for (const token of [[1, 2], { primary: "a" }, 7, true]) {
      const error = await rejectionOf(() =>
        loadDaemonConfig({
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, JSON.stringify({ storage: { token } })),
          env: REQUIRED_ENV,
        }),
      );

      expect(error.code, JSON.stringify(token)).toBe("invalid-input");
      expect(error.detail, JSON.stringify(token)).toContain("storage.token");
    }
  });
});

/** A reader that resolves the given text for one path, and null for every other. */
function fileAt(path: string, text: string): (asked: string) => Promise<string | null> {
  return async (asked: string): Promise<string | null> => (asked === path ? text : null);
}
