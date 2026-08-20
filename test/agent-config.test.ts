/*
 * Agent configuration: which source wins for a setting, what a malformed value
 * costs, and what the loader supplies when nothing configures it.
 *
 * Every input is injected — the file reader, the environment and the flags — so
 * the suite reads no file, no environment variable and no command line.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_BIND_HOST,
  DEFAULT_DURABILITY,
  DEFAULT_CONFIG_PATHS,
  DEFAULT_LISTEN,
  DEFAULT_REGION,
  loadAgentConfig,
  parseHostPort,
} from "../src/agent/config.ts";
import { rejectionOf, rejectsWith } from "./_helpers.ts";

/** The four settings with no default; every case starts from these. */
const REQUIRED_ENV: Record<string, string> = {
  SCAFO_S3_ENDPOINT: "http://store.test:9000",
  SCAFO_S3_BUCKET: "registry",
  SCAFO_S3_ACCESS_KEY: "key",
  SCAFO_S3_SECRET_KEY: "secret",
};

const CONFIG_PATH = "/etc/scafo/scafo.config.jsonc";

describe("source precedence", () => {
  it("lets a flag override both the environment and the file", async () => {
    const config = await loadAgentConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ bucket: { bucket: "from-file" } })),
      env: { ...REQUIRED_ENV, SCAFO_S3_BUCKET: "from-env" },
      flags: { bucket: "from-flag" },
    });

    expect(config.bucket.bucket).toBe("from-flag");
  });

  it("lets the environment override the file", async () => {
    const config = await loadAgentConfig({
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

    const config = await loadAgentConfig({
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
    const config = await loadAgentConfig({
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
    const config = await loadAgentConfig({
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
    const config = await loadAgentConfig({
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

    const config = await loadAgentConfig({
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

    const config = await loadAgentConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, jsonc),
    });

    expect(config.bucket.endpoint).toBe("http://store.test:9000");
    expect(config.bucket.bucket).toBe("registry");
  });

  it("refuses a malformed file instead of ignoring it", async () => {
    const error = await rejectsWith(
      () =>
        loadAgentConfig({
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
        loadAgentConfig({
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
        loadAgentConfig({
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

    const config = await loadAgentConfig({
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

    const config = await loadAgentConfig({
      readFile: fileAt(second, JSON.stringify({ bucket: { bucket: "from-second-path" } })),
      env: { ...REQUIRED_ENV, SCAFO_S3_BUCKET: undefined },
    });

    expect(config.bucket.bucket).toBe("from-second-path");
  });
});

describe("required settings", () => {
  it("names the file key, the environment variables and the flag that could supply it", async () => {
    const error = await rejectsWith(() => loadAgentConfig({ env: {} }), "invalid-input");

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
      const error = await rejectsWith(() => loadAgentConfig({ env }), "invalid-input");

      for (const mention of mentions) {
        expect(error.detail, `without ${missing}`).toContain(mention);
      }
    }
  });
});

describe("addresses", () => {
  it("keeps a valid host:port exactly as it was written", async () => {
    const config = await loadAgentConfig({
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
          () => loadAgentConfig({ env: { ...REQUIRED_ENV, [variable]: value } }),
          "invalid-input",
        );

        expect(error.detail, `${variable}=${value}`).toContain(field);
      }
    }
  });

  it("quotes the address it could not parse back to the operator", async () => {
    const error = await rejectsWith(
      () => loadAgentConfig({ env: { ...REQUIRED_ENV, SCAFO_LISTEN: "store.test" } }),
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
    const config = await loadAgentConfig({
      env: { ...REQUIRED_ENV, SCAFO_PLATFORM_DOMAINS: " apps.test, edge.example.com ,," },
    });

    expect(config.platformDomains).toEqual(["apps.test", "edge.example.com"]);
  });

  it("reads a list written as an array in the config file", async () => {
    const config = await loadAgentConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ platformDomains: ["apps.test"] })),
      env: REQUIRED_ENV,
    });

    expect(config.platformDomains).toEqual(["apps.test"]);
  });

  it("refuses the whole list when any one host is malformed", async () => {
    const error = await rejectionOf(() =>
      loadAgentConfig({
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
        loadAgentConfig({
          configPath: CONFIG_PATH,
          readFile: fileAt(CONFIG_PATH, JSON.stringify({ platformDomains: [1, 2] })),
          env: REQUIRED_ENV,
        }),
      "invalid-input",
    );

    expect(error.detail).toContain("platformDomains");
  });

  it("serves no wildcard domains until one is configured", async () => {
    const config = await loadAgentConfig({ env: REQUIRED_ENV });

    expect(config.platformDomains).toEqual([]);
  });
});

describe("the labels a node carries", () => {
  it("reads the comma syntax a flag and an environment variable carry", async () => {
    const config = await loadAgentConfig({
      env: { ...REQUIRED_ENV, SCAFO_NODE_LABELS: " tier=fast, region = eu-west-1 ,," },
    });

    expect(config.node.labels).toEqual({ tier: "fast", region: "eu-west-1" });
  });

  it("reads the object the config file writes them as", async () => {
    const config = await loadAgentConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ node: { labels: { tier: "fast" } } })),
      env: REQUIRED_ENV,
    });

    expect(config.node.labels).toEqual({ tier: "fast" });
  });

  it("lets the inline form replace the file's whole set rather than merging into it", async () => {
    const config = await loadAgentConfig({
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
    const config = await loadAgentConfig({ env: REQUIRED_ENV });

    expect(config.node.labels).toBeUndefined();
  });

  it.each(["tier", "Tier=fast", "tier=FAST", "tier=fast,tier=slow", "=fast"])(
    "refuses %p, naming the setting",
    async (value) => {
      const error = await rejectsWith(
        () => loadAgentConfig({ env: { ...REQUIRED_ENV, SCAFO_NODE_LABELS: value } }),
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
          loadAgentConfig({
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
    const config = await loadAgentConfig({ env: REQUIRED_ENV });

    /* The safe half of the setting: a process nothing outside this machine can
       reach is what a single node wants, and is never the wrong answer. */
    expect(config.runtime.bindHost).toBe(DEFAULT_BIND_HOST);
    expect(config.runtime.bindHost).toBe("127.0.0.1");
  });

  it("takes the wildcard addresses a multi-node fleet needs", async () => {
    for (const host of ["0.0.0.0", "::", "10.0.0.4"]) {
      const config = await loadAgentConfig({
        env: { ...REQUIRED_ENV, SCAFO_BIND_HOST: host },
      });

      expect(config.runtime.bindHost, host).toBe(host);
    }
  });

  it("refuses an address no process could bind", async () => {
    const error = await rejectsWith(
      () => loadAgentConfig({ env: { ...REQUIRED_ENV, SCAFO_BIND_HOST: "0.0.0.0:8080" } }),
      "invalid-input",
    );

    /* A bare host: the ports come from the allocator, and a pair written here
       would be two sources of truth for what a process listens on. */
    expect(error.detail).toContain("runtime.bindHost");
  });
});

describe("when a write counts as durable", () => {
  it("acknowledges against the bucket until the operator trades that away", async () => {
    const config = await loadAgentConfig({ env: REQUIRED_ENV });

    /* The safe half: with every write in the bucket before it is acknowledged,
       losing every node at once still loses nothing. */
    expect(config.runtime.durability).toBe(DEFAULT_DURABILITY);
    expect(config.runtime.durability).toBe("bucket");
  });

  it("takes either mode, from any source, flags first", async () => {
    const fromEnv = await loadAgentConfig({
      env: { ...REQUIRED_ENV, SCAFO_DURABILITY: "fleet" },
    });
    const flagWins = await loadAgentConfig({
      flags: { durability: "bucket" },
      env: { ...REQUIRED_ENV, SCAFO_DURABILITY: "fleet" },
    });

    expect(fromEnv.runtime.durability).toBe("fleet");
    expect(flagWins.runtime.durability).toBe("bucket");
  });

  it("refuses a mode the runtime does not have", async () => {
    const error = await rejectsWith(
      () => loadAgentConfig({ env: { ...REQUIRED_ENV, SCAFO_DURABILITY: "quorum" } }),
      "invalid-input",
    );

    expect(error.detail).toContain("runtime.durability");
    expect(error.detail).toContain('"bucket"');
    expect(error.detail).toContain('"fleet"');
  });
});

describe("node identity and defaults", () => {
  it("falls back to a loopback listener, the default signing region and no extra addresses", async () => {
    const config = await loadAgentConfig({ env: REQUIRED_ENV });

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
    const config = await loadAgentConfig({ env: REQUIRED_ENV });

    expect(config.node.id).toBeUndefined();
    expect(config.node.stateDir).toBeUndefined();
  });

  it("keeps a configured node id, which pins the identity the node keeps", async () => {
    const config = await loadAgentConfig({
      env: { ...REQUIRED_ENV, SCAFO_NODE_ID: "node_west-1" },
    });

    expect(config.node.id).toBe("node_west-1");
  });

  it("takes the state directory from a flag, the environment or the file", async () => {
    const fromFlag = await loadAgentConfig({
      env: { ...REQUIRED_ENV, SCAFO_STATE_DIR: "/from/env" },
      flags: { "state-dir": "/from/flag" },
    });
    const fromEnv = await loadAgentConfig({
      configPath: CONFIG_PATH,
      readFile: fileAt(CONFIG_PATH, JSON.stringify({ node: { stateDir: "/from/file" } })),
      env: { ...REQUIRED_ENV, SCAFO_STATE_DIR: "/from/env" },
    });
    const fromFile = await loadAgentConfig({
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
        loadAgentConfig({ env: { ...REQUIRED_ENV, SCAFO_NODE_ID: id } }),
      );

      expect(error.code, `for node id "${id}"`).toBe("invalid-slug");
    }
  });
});

describe("which ingress the node drives", () => {
  it("leaves the ingress off when nothing says there is one", async () => {
    const config = await loadAgentConfig({ env: REQUIRED_ENV });

    expect(config.ingress).toBeUndefined();
  });

  it("reads a Caddy admin API on its own as asking for Caddy", async () => {
    /* The setting predates there being a choice, and a configuration that
       already worked must go on working without naming a driver. */
    const config = await loadAgentConfig({
      env: { ...REQUIRED_ENV, SCAFO_CADDY_ADMIN: "http://127.0.0.1:2019" },
    });

    expect(config.ingress).toEqual({ driver: "caddy", adminUrl: "http://127.0.0.1:2019" });
  });

  it("takes Traefik by name, and needs nothing else to reach it", async () => {
    /* Nothing else, because there is nothing to reach: Traefik polls the agent
       rather than being called by it. */
    const config = await loadAgentConfig({
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
        loadAgentConfig({
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
      loadAgentConfig({ env: { ...REQUIRED_ENV, SCAFO_INGRESS_DRIVER: "nginx" } }),
    );

    expect(error.code).toBe("invalid-input");
    expect(error.detail).toContain(`"caddy"`);
    expect(error.detail).toContain(`"traefik"`);
  });

  it("lets a flag pick the driver over what the file says", async () => {
    const config = await loadAgentConfig({
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
    const config = await loadAgentConfig({
      env: { ...TRAEFIK_ENV, SCAFO_TRAEFIK_ENTRYPOINTS: "web, websecure" },
    });

    expect(config.ingress).toEqual({ driver: "traefik", entryPoints: ["web", "websecure"] });
  });

  it("lets a flag override what the environment names", async () => {
    const config = await loadAgentConfig({
      env: { ...TRAEFIK_ENV, SCAFO_TRAEFIK_ENTRYPOINTS: "web" },
      flags: { "traefik-entrypoints": "websecure" },
    });

    expect(config.ingress).toEqual({ driver: "traefik", entryPoints: ["websecure"] });
  });

  it("reads the array the file carries, which is what the text parses into", async () => {
    const config = await loadAgentConfig({
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
    const config = await loadAgentConfig({
      env: { ...REQUIRED_ENV, SCAFO_INGRESS_DRIVER: "traefik" },
    });

    expect(config.ingress?.entryPoints).toBeUndefined();
  });

  it("refuses a list that names nothing, because Traefik reads it as everything", async () => {
    /* Routers with no entryPoints attach to EVERY entryPoint Traefik has —
       including a TLS listener scafo holds no certificate for — so a mistyped
       list must fail the boot rather than claim the whole surface. */
    const error = await rejectionOf(() =>
      loadAgentConfig({
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
      const error = await rejectionOf(() => loadAgentConfig({ env: { ...REQUIRED_ENV, ...env } }));

      expect(error.code).toBe("invalid-input");
      expect(error.detail).toContain("caddy");
      expect(error.detail).toContain("websecure");
    }
  });
});

/** A reader that resolves the given text for one path, and null for every other. */
function fileAt(path: string, text: string): (asked: string) => Promise<string | null> {
  return async (asked: string): Promise<string | null> => (asked === path ? text : null);
}
