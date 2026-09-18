/*
 * Daemon configuration: which source wins for a setting, what a malformed value costs, and what
 * the loader supplies when nothing configures it.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_JSON_BYTES,
  DEFAULT_BIND_HOST,
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
import { ENV_NAME_RULE, RESERVED_ENV_NAMES } from "../src/core/utils/env.ts";
import {
  DEFAULT_ACTIVE_TASKS,
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_APPLICATION_ACTIVE_TASKS,
  DEFAULT_APPLICATION_QUEUED_TASKS,
  DEFAULT_APPLICATION_STAGED_BYTES,
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
    config.applicationActiveTasks,
    config.queuedTasks,
    config.applicationQueuedTasks,
    config.stagedBytes,
    config.applicationStagedBytes,
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
        SCAFO_ADVERTISE: "node4.internal:7401",
      },
    });

    expect(config.node).toMatchObject({
      listen: "0.0.0.0:7400",
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
    const settings: [string, string][] = [
      ["SCAFO_LISTEN", "node.listen"],
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

    expect(error.detail).toContain("runtime.bindHost");
  });

  it("dials a wildcard bind on loopback, and every other bind exactly as configured", async () => {
    const dialled = async (bindHost?: string): Promise<string> => {
      const config = await loadDaemonConfig({
        env: bindHost === undefined ? REQUIRED_ENV : { ...REQUIRED_ENV, SCAFO_BIND_HOST: bindHost },
      });
      return runtimeDialHost(config.runtime);
    };

    await expect(dialled("0.0.0.0")).resolves.toBe("127.0.0.1");
    await expect(dialled("::")).resolves.toBe("127.0.0.1");
    await expect(dialled()).resolves.toBe(DEFAULT_BIND_HOST);
    await expect(dialled("10.83.0.1")).resolves.toBe("10.83.0.1");
    await expect(dialled("node-a.internal")).resolves.toBe("node-a.internal");
  });
});

describe("deploy resource limits", () => {
  it("ships finite safeguards for artifact bytes and archive entries", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.deploy).toEqual({
      artifactBytes: DEFAULT_ARTIFACT_BYTES,
      archiveEntries: DEFAULT_ARCHIVE_ENTRIES,
      activeTasks: DEFAULT_ACTIVE_TASKS,
      applicationActiveTasks: DEFAULT_APPLICATION_ACTIVE_TASKS,
      queuedTasks: DEFAULT_QUEUED_TASKS,
      applicationQueuedTasks: DEFAULT_APPLICATION_QUEUED_TASKS,
      stagedBytes: DEFAULT_STAGED_BYTES,
      applicationStagedBytes: DEFAULT_APPLICATION_STAGED_BYTES,
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
        applicationActiveTasks: 2,
        queuedTasks: 6,
        applicationQueuedTasks: 3,
        stagedBytes: 1000,
        applicationStagedBytes: 800,
        receiveTimeoutMs: 10,
        queueTimeoutMs: 20,
        taskTimeoutMs: 30,
        outputBytes: 40,
      },
    });
    const env = {
      ...REQUIRED_ENV,
      SCAFO_ACTIVE_TASKS: "5",
      SCAFO_APPLICATION_ACTIVE_TASKS: "4",
      SCAFO_QUEUED_TASKS: "8",
      SCAFO_APPLICATION_QUEUED_TASKS: "6",
      SCAFO_STAGED_BYTES: "2000",
      SCAFO_APPLICATION_STAGED_BYTES: "1500",
      SCAFO_RECEIVE_TIMEOUT_MS: "100",
      SCAFO_QUEUE_TIMEOUT_MS: "200",
      SCAFO_TASK_TIMEOUT_MS: "300",
      SCAFO_OUTPUT_BYTES: "400",
    };
    const flags = {
      "active-tasks": "7",
      "application-active-tasks": "6",
      "queued-tasks": "10",
      "application-queued-tasks": "8",
      "staged-bytes": "3000",
      "application-staged-bytes": "2500",
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
      env: { ...REQUIRED_ENV, SCAFO_QUEUED_TASKS: "0", SCAFO_APPLICATION_QUEUED_TASKS: "0" },
    });
    expect(zero.deploy).toMatchObject({ queuedTasks: 0, applicationQueuedTasks: 0 });

    for (const [env, detail] of [
      [
        { SCAFO_ACTIVE_TASKS: "1", SCAFO_APPLICATION_ACTIVE_TASKS: "2" },
        `"deploy.applicationActiveTasks" must not exceed "deploy.activeTasks"`,
      ],
      [
        { SCAFO_QUEUED_TASKS: "1", SCAFO_APPLICATION_QUEUED_TASKS: "2" },
        `"deploy.applicationQueuedTasks" must not exceed "deploy.queuedTasks"`,
      ],
      [
        { SCAFO_STAGED_BYTES: "1073741824", SCAFO_APPLICATION_STAGED_BYTES: "1073741825" },
        `"deploy.applicationStagedBytes" must not exceed "deploy.stagedBytes"`,
      ],
      [
        {
          SCAFO_ARTIFACT_BYTES: "100",
          SCAFO_STAGED_BYTES: "99",
          SCAFO_APPLICATION_STAGED_BYTES: "99",
        },
        `"deploy.stagedBytes" must be at least "deploy.artifactBytes"`,
      ],
      [
        { SCAFO_ARTIFACT_BYTES: "100", SCAFO_APPLICATION_STAGED_BYTES: "99" },
        `"deploy.applicationStagedBytes" must be at least "deploy.artifactBytes"`,
      ],
    ] as const) {
      const error = await rejectsWith(
        () => loadDaemonConfig({ env: { ...REQUIRED_ENV, ...env } }),
        "invalid-input",
      );

      /* The refusal names both sides, so an operator can see which one to move. */
      expect(error.detail).toBe(detail);
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
      env: { ...REQUIRED_ENV, SCAFO_CELLD_ENV: " CELLD_OTEL=1, CELLD_IDLE_EVICT_S = 900 ,," },
    });

    expect(config.runtime.celldEnv).toEqual({ CELLD_OTEL: "1", CELLD_IDLE_EVICT_S: "900" });
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

    expect(config.runtime.celldEnv).toEqual({ CELLD_OTEL: "1", RUST_LOG: "debug" });
  });

  it("hands over none at all when nothing configures them", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.runtime.celldEnv).toBeUndefined();
  });

  it("REFUSES a name the runtime driver writes itself, naming the variable", async () => {
    for (const name of ["AWS_REGION", "CELLD_ADDR"]) {
      const error = await rejectsWith(
        () => loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_CELLD_ENV: `${name}=1` } }),
        "invalid-input",
      );

      expect(error.detail, name).toContain(name);
      expect(error.detail, name).toContain("runtime.celldEnv");
    }
  });

  it.each(RESERVED_ENV_NAMES)(
    "refuses %s under the one rule every variable name is read by, naming what a name may be",
    async (name) => {
      const error = await rejectsWith(
        () => loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_CELLD_ENV: `${name}=1` } }),
        "invalid-input",
      );

      expect(error.detail, name).toContain(name);
      expect(error.detail, name).toContain(ENV_NAME_RULE);
    },
  );

  it("passes upstream Celld policy through without Scafo defaults", async () => {
    const config = await loadDaemonConfig({
      env: {
        ...REQUIRED_ENV,
        SCAFO_CELLD_ENV:
          "CELLD_DURABILITY=bucket,CELLD_IDLE_EVICT_S=900,CELLD_SHUTDOWN_TOTAL_MS=60000",
      },
    });

    expect(config.runtime.celldEnv).toEqual({
      CELLD_DURABILITY: "bucket",
      CELLD_IDLE_EVICT_S: "900",
      CELLD_SHUTDOWN_TOTAL_MS: "60000",
    });
  });

  it.each(["AWS_ACCESS_KEY_ID", "CELLD_TRUST_FORWARDED_HEADERS"])(
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

  it("takes no setting from a key the config file makes an object answer for", async () => {
    /* The document names the bucket only under a member the parser would turn
       into a prototype. Read as a document it holds nothing, so the required
       settings are missing rather than inherited. */
    const error = await rejectsWith(
      () =>
        loadDaemonConfig({
          configPath: CONFIG_PATH,
          readFile: fileAt(
            CONFIG_PATH,
            `{"__proto__": ${JSON.stringify({ bucket: { endpoint: "http://x", bucket: "b", accessKey: "a", secretKey: "s" } })}}`,
          ),
          env: {},
        }),
      "invalid-input",
    );

    expect(error.detail).toContain("bucket");
  });

  it("passes celld's own memory limits through to every runtime", async () => {
    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(
        CONFIG_PATH,
        JSON.stringify({
          runtime: {
            celldEnv: { CELLD_MAX_RSS_MB: "512", CELLD_MAX_RESIDENT_CELLS: "64" },
          },
        }),
      ),
      env: REQUIRED_ENV,
    });

    expect(config.runtime.celldEnv).toEqual({
      CELLD_MAX_RSS_MB: "512",
      CELLD_MAX_RESIDENT_CELLS: "64",
    });
  });

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
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.api).toEqual({ public: true, jsonBytes: DEFAULT_JSON_BYTES });
  });

  it("is turned off from a flag, the environment or the file alike", async () => {
    const fromFlag = await loadDaemonConfig({
      env: REQUIRED_ENV,
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

      expect(error.detail).toContain("observability.ingressAccessLog");
      expect(error.detail).toContain("observability.enabled");
      expect(error.detail).toContain("--ingress-access-log");
      expect(error.detail).toContain("/var/log/access.log");
    }
  });

  it("is accepted the moment observability is turned on in ANY source", async () => {
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
        JSON.stringify({ runtime: { celldEnv: { CELLD_OTEL: "2", CELLD_IDLE_EVICT_S: "900" } } }),
      ),
      env: { ...REQUIRED_ENV, SCAFO_OBSERVABILITY: "1" },
    });

    expect(turnedOff.runtime.celldEnv).toEqual({ CELLD_OTEL: "0" });
    expect(tuned.runtime.celldEnv).toEqual({ CELLD_OTEL: "2", CELLD_IDLE_EVICT_S: "900" });
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
    expect(config.node.advertise).toBeUndefined();
    expect(config.bucket.prefix).toBeUndefined();
  });

  it("invents no node id, leaving the one the node persisted to stand", async () => {
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

describe("the ingress settings, which are not about which ingress", () => {
  it("leaves the ingress off when nothing configures one", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.ingress).toBeUndefined();
  });

  it("carries the token, which is the one thing every ingress needs", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_INGRESS_TOKEN: "shared" },
    });

    expect(config.ingress).toEqual({ token: ["shared"] });
  });
});

describe("the Traefik entryPoints the routers attach to", () => {
  it("reads a comma-separated list from the environment", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_TRAEFIK_ENTRYPOINTS: "web, websecure" },
    });

    expect(config.ingress).toEqual({ entryPoints: ["web", "websecure"] });
  });

  it("lets a flag override what the environment names", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_TRAEFIK_ENTRYPOINTS: "web" },
      flags: { "traefik-entrypoints": "websecure" },
    });

    expect(config.ingress).toEqual({ entryPoints: ["websecure"] });
  });

  it("reads the array the file carries, which is what the text parses into", async () => {
    const config = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ ingress: { entryPoints: ["websecure"] } })),
      env: REQUIRED_ENV,
    });

    expect(config.ingress).toEqual({ entryPoints: ["websecure"] });
  });

  it("leaves them absent when nothing names any, so the node's default applies", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.ingress?.entryPoints).toBeUndefined();
  });

  it("refuses a list that names nothing, because Traefik reads it as everything", async () => {
    const error = await rejectionOf(() =>
      loadDaemonConfig({
        env: { ...REQUIRED_ENV, SCAFO_TRAEFIK_ENTRYPOINTS: " , " },
      }),
    );

    expect(error.code).toBe("invalid-input");
    expect(error.detail).toContain("ingress.entryPoints");
  });
});

describe("the tokens guarding what the ingress reads", () => {
  it("reads the comma-separated list an operator shares with their ingress", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_INGRESS_TOKEN: " new-token , old-token " },
    });

    expect(config.ingress).toEqual({ token: ["new-token", "old-token"] });
  });

  it("lets a flag override what the environment names", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_INGRESS_TOKEN: "from-env" },
      flags: { "ingress-token": "from-flag" },
    });

    expect(config.ingress).toEqual({ token: ["from-flag"] });
  });

  it("takes a plain string or an array from the file, the array carrying entries whole", async () => {
    const asString = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ ingress: { token: "new,old" } })),
      env: REQUIRED_ENV,
    });
    const asArray = await loadDaemonConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(
        CONFIG_PATH,
        JSON.stringify({ ingress: { token: [" new ", "with,comma"] } }),
      ),
      env: REQUIRED_ENV,
    });

    expect(asString.ingress).toEqual({ token: ["new", "old"] });
    expect(asArray.ingress).toEqual({ token: ["new", "with,comma"] });
  });

  it("leaves the node minting its own when nothing names any", async () => {
    const config = await loadDaemonConfig({ env: REQUIRED_ENV });

    expect(config.ingress).toBeUndefined();
  });

  it("still answers to the name the token had when it only guarded storage", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_STORAGE_TOKEN: "old-name" },
    });

    expect(config.ingress).toEqual({ token: ["old-name"] });
  });

  it("prefers the current name when both are set", async () => {
    const config = await loadDaemonConfig({
      env: { ...REQUIRED_ENV, SCAFO_INGRESS_TOKEN: "current", SCAFO_STORAGE_TOKEN: "old-name" },
    });

    expect(config.ingress).toEqual({ token: ["current"] });
  });

  it("sits beside the entryPoints, which are the only other ingress setting left", async () => {
    const config = await loadDaemonConfig({
      env: {
        ...REQUIRED_ENV,
        SCAFO_INGRESS_TOKEN: "shared",
        SCAFO_TRAEFIK_ENTRYPOINTS: "websecure",
      },
    });

    expect(config.ingress).toEqual({ token: ["shared"], entryPoints: ["websecure"] });
  });

  it("refuses a value that is there and holds nothing, rather than quietly minting", async () => {
    const written: Array<[string, LoadConfigOptions]> = [
      ["an empty variable", { env: { ...REQUIRED_ENV, SCAFO_INGRESS_TOKEN: "" } }],
      ["an empty flag", { env: REQUIRED_ENV, flags: { "ingress-token": "" } }],
      [
        "an empty string in the file",
        {
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, JSON.stringify({ ingress: { token: "" } })),
          env: REQUIRED_ENV,
        },
      ],
      [
        "an empty array in the file",
        {
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, JSON.stringify({ ingress: { token: [] } })),
          env: REQUIRED_ENV,
        },
      ],
    ];

    for (const [label, opts] of written) {
      const error = await rejectionOf(() => loadDaemonConfig(opts));

      expect(error.code, label).toBe("invalid-input");
      expect(error.detail, label).toContain("ingress.token");
    }
  });

  it("refuses an entry holding nothing, whichever spelling carried it", async () => {
    for (const written of ["a,,b", " , ", "a,  "]) {
      const error = await rejectionOf(() =>
        loadDaemonConfig({ env: { ...REQUIRED_ENV, SCAFO_INGRESS_TOKEN: written } }),
      );

      expect(error.code, written).toBe("invalid-input");
      expect(error.detail, written).toContain("ingress.token");
    }

    const inFile = await rejectionOf(() =>
      loadDaemonConfig({
        configPath: CONFIG_PATH,
        readFile: fileAt(CONFIG_PATH, JSON.stringify({ ingress: { token: ["a", "  "] } })),
        env: REQUIRED_ENV,
      }),
    );

    expect(inFile.code).toBe("invalid-input");
    expect(inFile.detail).toContain("ingress.token");
  });

  it("refuses a value that is neither a token nor a list of them", async () => {
    for (const token of [[1, 2], { primary: "a" }, 7, true]) {
      const error = await rejectionOf(() =>
        loadDaemonConfig({
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, JSON.stringify({ ingress: { token } })),
          env: REQUIRED_ENV,
        }),
      );

      expect(error.code, JSON.stringify(token)).toBe("invalid-input");
      expect(error.detail, JSON.stringify(token)).toContain("ingress.token");
    }
  });
});

/** A reader that resolves the given text for one path, and null for every other. */
function fileAt(path: string, text: string): (asked: string) => Promise<string | null> {
  return async (asked: string): Promise<string | null> => (asked === path ? text : null);
}
