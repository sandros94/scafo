/*
 * End-to-end TLS storage: Caddy uses only the node storage URL and token; shared storage reuses
 * the certificate. The user-defined network resolves the challenge hostname to Caddy.
 *
 * THE SITE IS THE FLEET'S OWN NAME. The storage module routes a certificate to
 * the fleet whose routing document names its domain and writes a name nobody
 * owns nowhere, so the site is this node's platform apex: the one host a node
 * publishes with nothing deployed. The ACME account names no domain and stays
 * on each Caddy's own disk.
 */

import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetailedPeerCertificate, TLSSocket } from "node:tls";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readTlsObject,
  type RegistryContext,
  tlsLocksPrefix,
} from "../../src/core/registry/index.ts";
import {
  NODE_IMAGE,
  BOOT_DEADLINE_MS,
  type BucketSettings,
  collectLogs,
  type CommandResult,
  DEADLINE_MS,
  registryAt,
  REPO_ROOT,
  run,
  send,
  SETUP_TIMEOUT_MS,
  type StartedStore,
  startStore,
  STEP_TIMEOUT_MS,
  storeEnv,
  until,
} from "./_harness.ts";

const E2E = process.env.SCAFO_E2E === "1";

/**
 * Caddy with both `scafo` modules compiled in. The published image is the
 * default; point this at a locally built tag to run the suite against modules
 * that are not released yet.
 */
const CADDY_IMAGE: string =
  process.env.SCAFO_E2E_CADDY_IMAGE ?? "ghcr.io/sandros94/scafo-caddy:edge";

/**
 * What the `scafo` dynamic-upstreams module logs about a poll that did not
 * return a document, and about the poll that ended the run. It says which of
 * the two it is, and that distinction is the whole of the assertion below: the
 * cold line is a Caddy that has never held a document, the warm one a Caddy
 * that holds one and keeps serving it.
 */
const FETCH_FAILED_COLD = "fetching the routing document failed and none is known yet";
const FETCH_FAILED_WARM = "fetching the routing document failed; serving the last one that parsed";
const FETCH_RECOVERED = "the routing document is available again";

/** The ACME test CA. It mints a fresh issuance chain on every start. */
const PEBBLE_IMAGE = "ghcr.io/letsencrypt/pebble:latest";

const CADDY_HTTPS_PORT = 443;
/** Port for Pebble's unused HTTP challenge. */
const HTTP_PORT = 80;
const NODE_PORT = 7400;
/** Pebble's ACME directory, and the management interface serving its roots. */
const PEBBLE_PORT = 14000;
const PEBBLE_MANAGEMENT_PORT = 15000;

/**
 * The name the certificate is for, and a network alias on the first Caddy, so
 * that the CA validating a challenge for it reaches exactly that container.
 */
const SITE = "site.scafo-e2e.internal";
/** The second Caddy answers for the same name, but is not what resolves to it. */
const SITE_ALIAS_B = "site-b.scafo-e2e.internal";
/** Where Caddy sends every storage call; the node is the only side with a bucket. */
const NODE_ALIAS = "node.scafo-e2e.internal";
/** Not a choice: Pebble's own TLS certificate names `pebble`, `localhost` and `127.0.0.1`. */
const PEBBLE_ALIAS = "pebble";

/** Where the node keeps its identity, and where it mints the ingress token. */
const NODE_STATE_DIR = "/var/lib/scafo-tls";
/** The two files a Caddy is given, and the only two it needs. */
const TOKEN_IN_CADDY = "/etc/scafo/ingress-token";
const DIRECTORY_ROOT_IN_CADDY = "/etc/scafo/acme-directory-root.pem";
const CONFIG_IN_CADDY = "/etc/caddy/config.json";

/** Pebble reads this path at startup, relative to its working directory. */
const PEBBLE_CONFIG = "/test/config/pebble-config.json";
/** The static root behind Pebble's own directory certificate, shipped in its image. */
const PEBBLE_DIRECTORY_ROOT = "/test/certs/pebble.minica.pem";

const BUCKET: BucketSettings = {
  bucket: "scafo-e2e-tls",
  prefix: "e2e",
  accessKey: "scafo",
  secretKey: "scafo-secret",
  region: "us-east-1",
};

/** The site itself, so that the fleet's routing document names it. */
const PLATFORM_DOMAIN = SITE;
const NODE_ID = "node-e2e-tls";

/** How certmagic's key space names the two things this suite looks for. */
const CERTIFICATES_PREFIX = "certificates/";
const ACCOUNT_PREFIX = "acme/";

let network: StartedNetwork;
let store: StartedStore;
let pebble: StartedTestContainer;
let daemon: StartedTestContainer;
let registry: RegistryContext;

let apiPort: number;
/** The token the node minted, read back out of its state directory. */
let ingressToken: string;
/**
 * The static root behind Pebble's OWN certificate, shipped in its image. What
 * Caddy is given, and the only reason it will speak to the directory at all.
 */
let directoryRoot: string;
/**
 * The root of the chain Pebble ISSUES under, minted fresh on every start and
 * fetched from its management interface. What the test process verifies the
 * served certificate against; Caddy never sees it.
 */
let issuanceRoot: string;
/** Serial of the certificate the first Caddy was issued; the second must match it. */
let issuedSerial: string;

const caddies: Caddy[] = [];
const tmpDirs: string[] = [];
const daemonLog: string[] = [];
const pebbleLog: string[] = [];
/** Raw observations the report is written from; printed once at the end. */
const observed: Record<string, unknown> = {};

interface Caddy {
  name: string;
  container: StartedTestContainer;
  httpsPort: number;
  log: string[];
}

describe.skipIf(!E2E)("TLS through the node's storage surface, end to end", () => {
  beforeAll(async () => {
    network = await new Network().start();
    store = await startStore(BUCKET);
    registry = registryAt(store.fromHost, BUCKET);

    const files = await mkdtemp(join(tmpdir(), "scafo-e2e-tls-"));
    tmpDirs.push(files);
    const shipped = await readPebbleFiles(files);

    pebble = await new GenericContainer(PEBBLE_IMAGE)
      .withNetwork(network)
      .withNetworkAliases(PEBBLE_ALIAS)
      .withCopyContentToContainer([
        { content: withValidationPorts(shipped.config), target: PEBBLE_CONFIG },
      ])
      .withEnvironment({
        PEBBLE_VA_NOSLEEP: "1",
        PEBBLE_WFE_NONCEREJECT: "0",
      })
      .withExposedPorts(PEBBLE_PORT, PEBBLE_MANAGEMENT_PORT)
      .withLogConsumer(collectLogs(pebbleLog))
      .withWaitStrategy(Wait.forLogMessage(/ACME directory available at/))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    directoryRoot = shipped.directoryRoot;
    issuanceRoot = await pebbleIssuanceRoot(
      pebble.getMappedPort(PEBBLE_MANAGEMENT_PORT),
      directoryRoot,
    );

    daemon = await new GenericContainer(NODE_IMAGE)
      .withNetwork(network)
      .withNetworkAliases(NODE_ALIAS)
      .withBindMounts([{ source: REPO_ROOT, target: "/work", mode: "ro" }])
      .withWorkingDir("/work")
      .withEnvironment({
        ...storeEnv(store.fromContainers, BUCKET),
        SCAFO_NODE_ID: NODE_ID,
        SCAFO_TRANSPORT: "none",
        SCAFO_STATE_DIR: NODE_STATE_DIR,
        SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
        SCAFO_ADVERTISE: `127.0.0.1:${String(NODE_PORT)}`,
        SCAFO_BIND_HOST: "0.0.0.0",
        CELLD_ESBUILD: "/usr/local/bin/esbuild",
      })
      .withCommand([
        "node",
        "dist/cli/index.mjs",
        "sail",
        "--listen",
        `0.0.0.0:${String(NODE_PORT)}`,
      ])
      .withExposedPorts(NODE_PORT)
      .withLogConsumer(collectLogs(daemonLog))
      .withWaitStrategy(Wait.forLogMessage(/listening on/))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    apiPort = daemon.getMappedPort(NODE_PORT);
    ingressToken = await readIngressToken();

    /* Caddy starts issuing for the site at boot, and a name no document it
       holds yet names is a name its storage refuses to write: wait out the
       node's first reconcile pass, the one window it answers 503. */
    await until(
      "the node to publish its routing document",
      DEADLINE_MS,
      async () => {
        const routes = await send(
          apiPort,
          "/v1/ingress/routes",
          "GET",
          { authorization: `Bearer ${ingressToken}` },
          undefined,
        );
        return routes.status === 200 ? true : null;
      },
      { context: () => daemonLogTail() },
    );

    caddies.push(await startCaddy("caddy-a", SITE));
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    for (const caddy of caddies) await caddy.container.stop().catch(() => {});
    await daemon?.stop().catch(() => {});
    await pebble?.stop().catch(() => {});
    await store?.container.stop().catch(() => {});
    await network?.stop().catch(() => {});
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });

    console.log(`\n[e2e-tls] raw observations\n${JSON.stringify(observed, null, 2)}`);
  }, SETUP_TIMEOUT_MS);

  it(
    "mints the token at boot, and says where the operator will find it",
    () => {
      expect(daemonLog.join(""), daemonLogTail()).toContain(
        `ingress token at ${NODE_STATE_DIR}/ingress-token`,
      );
      expect(ingressToken.length).toBeGreaterThan(0);
      observed.tokenLength = ingressToken.length;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "obtains a certificate from the ACME CA and serves it",
    async () => {
      const started = Date.now();
      const answer = await until(
        `${SITE} to serve a certificate issued by the CA`,
        DEADLINE_MS,
        () => siteAnswer(caddies[0]),
        { context: () => `${caddyLogTail(caddies[0])}\n${pebbleLogTail()}` },
      );
      observed.issuanceMs = Date.now() - started;

      expect(answer.status).toBe(200);
      expect(answer.body).toBe(servedBody(caddies[0].name));

      expect(answer.cert.subjectaltname).toContain(`DNS:${SITE}`);
      expect(commonName(answer.cert.issuer)).toMatch(/^Pebble Intermediate CA/);
      expect(chainSubjects(answer.cert).join(" | ")).toMatch(/Pebble Intermediate CA/);

      issuedSerial = answer.cert.serialNumber;

      const caddyLog = caddies[0].log.join("");
      expect(caddyLog, caddyLogTail(caddies[0])).toContain('"msg":"obtaining certificate"');
      expect(caddyLog, caddyLogTail(caddies[0])).toContain(
        '"msg":"served key authentication certificate"',
      );
      expect(caddyLog, caddyLogTail(caddies[0])).toContain('"challenge":"tls-alpn-01"');
      expect(issuedSerials(), pebbleLogTail()).toEqual([normalizedSerial(issuedSerial)]);

      observed.served = {
        subject: commonName(answer.cert.subject),
        subjectAltName: answer.cert.subjectaltname,
        issuer: commonName(answer.cert.issuer),
        serialNumber: answer.cert.serialNumber,
        chain: chainSubjects(answer.cert),
        validTo: answer.cert.valid_to,
        issuedByCa: issuedSerials(),
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "kept every byte of that certificate in the bucket, through the node, and no ACME account",
    async () => {
      const keys = await storageList();
      const certificates = keys.filter((key) => key.startsWith(CERTIFICATES_PREFIX));
      const account = keys.filter((key) => key.startsWith(ACCOUNT_PREFIX));

      expect(certificates.some((key) => key.endsWith(".crt"))).toBe(true);
      expect(certificates.some((key) => key.endsWith(".key"))).toBe(true);
      /* The account is the ingress's, not the fleet's: in a fleet's bucket it
         would let that fleet act as this ingress towards its CA. */
      expect(account, JSON.stringify(keys)).toEqual([]);

      const certKey = certificates.find((key) => key.endsWith(".crt"));
      expect(certKey, `no certificate among ${JSON.stringify(keys)}`).toBeDefined();

      const stored = await storageGet(certKey ?? "");
      const parsed = new X509Certificate(stored);
      expect(parsed.subjectAltName).toContain(`DNS:${SITE}`);
      expect(parsed.serialNumber).toBe(issuedSerial);

      const fromBucket = await readTlsObject(registry, certKey ?? "");
      expect(fromBucket, `"${certKey ?? ""}" is not in the bucket`).not.toBeNull();
      expect(new TextDecoder().decode(fromBucket?.value)).toBe(stored);

      observed.storage = {
        keys,
        certificateKey: certKey,
        certificateBytes: stored.length,
        storedSerialNumber: parsed.serialNumber,
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "serves the same certificate from a second Caddy sharing that storage",
    async () => {
      const second = await startCaddy("caddy-b", SITE_ALIAS_B);
      caddies.push(second);

      const answer = await until(
        `the second Caddy to serve ${SITE}`,
        DEADLINE_MS,
        () => siteAnswer(second),
        { context: () => `${caddyLogTail(second)}\n${pebbleLogTail()}` },
      );

      expect(answer.status).toBe(200);
      expect(answer.body).toBe(servedBody(second.name));
      expect(answer.cert.serialNumber).toBe(issuedSerial);

      expect(second.log.join(""), caddyLogTail(second)).not.toContain(
        '"msg":"obtaining certificate"',
      );
      expect(issuedSerials(), pebbleLogTail()).toEqual([normalizedSerial(issuedSerial)]);

      observed.second = {
        serialNumber: answer.cert.serialNumber,
        issuer: commonName(answer.cert.issuer),
        body: answer.body,
        issuedByCa: issuedSerials(),
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "took its locks through the node, and left none of them behind",
    async () => {
      const log = caddies[0].log.join("");
      expect(log, caddyLogTail(caddies[0])).toContain('"msg":"acquiring lock"');
      expect(log, caddyLogTail(caddies[0])).toContain('"msg":"lock acquired"');
      expect(log, caddyLogTail(caddies[0])).toContain('"msg":"releasing lock"');

      const left = await until(
        "every lock taken to be released",
        DEADLINE_MS,
        async () => {
          const held = await registry.store.list(tlsLocksPrefix());
          return held.length === 0 ? [] : null;
        },
        { context: () => `${caddyLogTail(caddies[0])}\n${daemonLogTail()}` },
      );
      expect(left).toEqual([]);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "read the routing document with the same token, from the same process",
    async () => {
      /* The other half of what one token buys. The module logs a failed fetch
         once per state change and nothing at all when they succeed, so what it
         logged IS the evidence — and the presence of a Caddy that provisioned at
         all is the evidence that both modules resolved.

         At most one failure is expected here, and it is correct: a node refuses
         both routing routes with 503 `urn:scafo:draining` until its first
         reconcile pass has finished, because `{"v":1,"routes":[]}` would tell a
         poller the fleet answers on nothing. The suite waits that window out
         before starting Caddy, but a poll that still lands inside it is the cold
         line, once, carrying that 503, and then the recovery line as soon as the
         pass lands.

         Anything else fails: a warm failure is a document that WAS known and a
         later poll refused, and a cold failure that is not that 503 is the
         module, the token, or the endpoint. */
      const log = caddies[0].log.join("");

      expect(log, caddyLogTail(caddies[0])).toContain('"msg":"serving initial configuration"');
      expect(log, caddyLogTail(caddies[0])).not.toContain(FETCH_FAILED_WARM);

      const refused = log.split("\n").filter((line) => line.includes(FETCH_FAILED_COLD));
      for (const line of refused) {
        expect(line, caddyLogTail(caddies[0])).toContain("HTTP 503");
        expect(line, caddyLogTail(caddies[0])).toContain("The fleet's routing is not known yet");
      }

      /* And the refusal has to have lifted. A poll a second later parses a
         document and the module says so; one that never does is a node whose
         first pass never finished, which is the failure this window hides. */
      if (refused.length > 0) {
        await until(
          "the module to report the routing document available again",
          DEADLINE_MS,
          () => Promise.resolve(caddies[0].log.join("").includes(FETCH_RECOVERED) ? true : null),
          { context: () => caddyLogTail(caddies[0]) },
        );
      }

      observed.routingFetch = {
        drainingRefusalsBeforeFirstDocument: refused.length,
        failuresWithADocumentKnown: 0,
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "answers a caller presenting the wrong token, or none, with 401",
    async () => {
      const wrong = await send(
        apiPort,
        "/v1/storage/list?prefix=&recursive=true",
        "GET",
        { authorization: `Bearer ${ingressToken}-not` },
        undefined,
      );
      const none = await send(
        apiPort,
        "/v1/storage/list?prefix=&recursive=true",
        "GET",
        {},
        undefined,
      );

      expect(wrong.status, wrong.body).toBe(401);
      expect(none.status, none.body).toBe(401);
      observed.guarded = { wrongToken: wrong.status, noToken: none.status };
    },
    STEP_TIMEOUT_MS,
  );
});

/** One Caddy, given a URL, a token and a root, and nothing else. */
async function startCaddy(name: string, alias: string): Promise<Caddy> {
  const log: string[] = [];

  const container = await new GenericContainer(CADDY_IMAGE)
    .withNetwork(network)
    .withNetworkAliases(alias)
    .withCopyContentToContainer([
      { content: caddyConfig(name), target: CONFIG_IN_CADDY },
      { content: `${ingressToken}\n`, target: TOKEN_IN_CADDY, mode: 0o600 },
      { content: directoryRoot, target: DIRECTORY_ROOT_IN_CADDY },
    ])
    .withCommand(["caddy", "run", "--config", CONFIG_IN_CADDY])
    .withExposedPorts(CADDY_HTTPS_PORT)
    .withLogConsumer(collectLogs(log))
    .withWaitStrategy(Wait.forLogMessage(/serving initial configuration/))
    .withStartupTimeout(BOOT_DEADLINE_MS)
    .start();

  return { name, container, httpsPort: container.getMappedPort(CADDY_HTTPS_PORT), log };
}

/**
 * What a Caddy is configured with. Written here rather than kept as a fixture
 * because every value in it — the site name, the aliases, the two file paths —
 * is a constant this suite also asserts against, and a second copy of them in a
 * JSON file is a second copy to drift.
 *
 * only the TLS-ALPN CHALLENGE. Both would work, and the CA is configured for
 * both ports, but leaving the HTTP one enabled means the first attempt goes to a
 * port this server does not listen on, which costs a retry and proves nothing.
 *
 * BOTH MODULES, ON ONE FLEET DECLARED ONCE in the `scafo` app, which is the
 * only place an endpoint and a token are written. The routing half is here not
 * because this suite deploys anything — it deploys nothing — but because that is
 * the whole shape an operator runs, and provisioning it beside the storage half
 * is what proves the two coexist against one daemon rather than only apart.
 */
function caddyConfig(name: string): string {
  return JSON.stringify(
    {
      /* No admin block: nothing calls Caddy's admin API here, or anywhere. */
      storage: { module: "scafo" },
      apps: {
        scafo: {
          fleets: [
            {
              name: "default",
              endpoint: `http://${NODE_ALIAS}:${String(NODE_PORT)}`,
              token_file: TOKEN_IN_CADDY,
              prefer: "self",
              poll_interval: "1s",
            },
          ],
        },
        http: {
          servers: {
            scafo: {
              listen: [`:${String(CADDY_HTTPS_PORT)}`],
              routes: [
                {
                  match: [{ host: [SITE] }],
                  handle: [
                    { handler: "static_response", status_code: 200, body: servedBody(name) },
                  ],
                  terminal: true,
                },
                {
                  handle: [
                    {
                      handler: "reverse_proxy",
                      dynamic_upstreams: { source: "scafo" },
                      load_balancing: { selection_policy: { policy: "first" }, retries: 2 },
                    },
                  ],
                },
              ],
              /* No error route: this server holds a certificate for `SITE`
                 alone, so no request for an unrouted name can complete a
                 handshake to reach one. `e2e.test.ts` is where that 404 lives. */
              automatic_https: { disable_redirects: true },
            },
          },
        },
        tls: {
          certificates: { automate: [SITE] },
          automation: {
            policies: [
              {
                subjects: [SITE],
                issuers: [
                  {
                    module: "acme",
                    ca: `https://${PEBBLE_ALIAS}:${String(PEBBLE_PORT)}/dir`,
                    trusted_roots_pem_files: [DIRECTORY_ROOT_IN_CADDY],
                    challenges: { http: { disabled: true } },
                  },
                ],
              },
            ],
          },
        },
      },
    },
    null,
    2,
  );
}

/** What each Caddy answers with, so an assertion can tell which one served. */
function servedBody(name: string): string {
  return `served by ${name}`;
}

/**
 * The two files Pebble's image ships that this suite needs before Pebble runs:
 * the configuration it will be started with, and the static root behind its own
 * certificate. Read out of a container created and never started, so neither is
 * a copy of upstream's values kept here to drift.
 */
async function readPebbleFiles(dir: string): Promise<{ config: string; directoryRoot: string }> {
  const created = await docker(["create", PEBBLE_IMAGE]);
  expect(created.code, created.output).toBe(0);
  const id = created.output.trim().split("\n").at(-1) ?? "";

  try {
    return {
      config: await copyOut(id, PEBBLE_CONFIG, dir),
      directoryRoot: await copyOut(id, PEBBLE_DIRECTORY_ROOT, dir),
    };
  } finally {
    await docker(["rm", "-f", id]);
  }
}

/**
 * Pebble's shipped configuration with its validation ports moved to the real
 * ones — the whole reason a configuration is copied in at all. A challenge has
 * to arrive on the port Caddy actually serves, not on Pebble's test-only pair.
 */
function withValidationPorts(shipped: string): string {
  const config = JSON.parse(shipped) as { pebble: Record<string, unknown> };
  config.pebble.httpPort = HTTP_PORT;
  config.pebble.tlsPort = CADDY_HTTPS_PORT;
  return JSON.stringify(config, null, 2);
}

/** One file, copied out of a container and read as text. */
async function copyOut(container: string, path: string, dir: string): Promise<string> {
  const local = join(dir, path.split("/").at(-1) ?? "file");
  const copied = await docker(["cp", `${container}:${path}`, local]);
  expect(copied.code, copied.output).toBe(0);
  return readFile(local, "utf8");
}

/**
 * The root of the chain Pebble issues under, fetched from its management
 * interface over a connection verified against the static root shipped in its
 * image — so even this step trusts nothing it was not given beforehand.
 */
async function pebbleIssuanceRoot(port: number, trustedRoot: string): Promise<string> {
  const answer = await until("Pebble to serve its issuance root", BOOT_DEADLINE_MS, async () => {
    const got = await httpsGet({
      port,
      path: "/roots/0",
      servername: "localhost",
      ca: trustedRoot,
    });
    return got.status === 200 ? got : null;
  });
  return answer.body;
}

/** The node's ingress token, read out of the state directory it was minted in. */
async function readIngressToken(): Promise<string> {
  const read = await daemon.exec(["cat", `${NODE_STATE_DIR}/ingress-token`]);
  expect(read.exitCode, `${read.output}\n${daemonLogTail()}`).toBe(0);
  return read.output.trim();
}

/** Every key the node is storing, as the surface answers it. */
async function storageList(): Promise<string[]> {
  const answer = await send(
    apiPort,
    "/v1/storage/list?prefix=&recursive=true",
    "GET",
    { authorization: `Bearer ${ingressToken}` },
    undefined,
  );
  expect(answer.status, answer.body).toBe(200);
  return JSON.parse(answer.body) as string[];
}

/** One stored value, as the surface answers it. */
async function storageGet(key: string): Promise<string> {
  const answer = await send(
    apiPort,
    `/v1/storage/objects/${key}`,
    "GET",
    { authorization: `Bearer ${ingressToken}` },
    undefined,
  );
  expect(answer.status, answer.body).toBe(200);
  return answer.body;
}

/** One HTTPS request to a Caddy for the site name, or null while it has none. */
async function siteAnswer(caddy: Caddy): Promise<TlsAnswer | null> {
  const answer = await httpsGet({
    port: caddy.httpsPort,
    path: "/",
    servername: SITE,
    ca: issuanceRoot,
  });
  return answer.status === 200 ? answer : null;
}

interface TlsAnswer {
  status: number;
  body: string;
  cert: DetailedPeerCertificate;
}

interface TlsRequest {
  port: number;
  path: string;
  /** The name presented in SNI, and the one the certificate is checked against. */
  servername: string;
  /** The only root trusted for the connection; verification stays on. */
  ca: string;
}

/**
 * One GET over TLS, made the way an assertion about a certificate needs it: to a
 * published port on the host, for a name that resolves nowhere here, with
 * exactly one trusted root and hostname checking left on — and handing back the
 * peer certificate beside the answer.
 *
 * A fresh connection every time (`agent: false`), because a pooled one would
 * report the certificate of whatever handshake happened first.
 */
function httpsGet(request: TlsRequest): Promise<TlsAnswer> {
  return new Promise<TlsAnswer>((settle, fail) => {
    const call = httpsRequest(
      {
        host: "127.0.0.1",
        port: request.port,
        path: request.path,
        method: "GET",
        servername: request.servername,
        headers: { host: request.servername },
        ca: request.ca,
        rejectUnauthorized: true,
        agent: false,
      },
      (response) => {
        const cert = (response.socket as TLSSocket).getPeerCertificate(true);
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => settle({ status: response.statusCode ?? 0, body: text, cert }));
      },
    );
    call.on("error", fail);
    call.end();
  });
}

/** The subjects of every certificate the server sent, leaf first. */
function chainSubjects(cert: DetailedPeerCertificate): string[] {
  const subjects: string[] = [];
  let current: DetailedPeerCertificate | undefined = cert;

  while (current !== undefined) {
    subjects.push(commonName(current.subject));
    const next: DetailedPeerCertificate | undefined = current.issuerCertificate;
    current = next === current ? undefined : next;
  }
  return subjects;
}

/**
 * The common name of a certificate's subject or issuer, as one string. A name
 * may legitimately carry several, and node hands those back as an array.
 */
function commonName(name: { CN?: string | string[] }): string {
  if (name.CN === undefined) return "";
  return Array.isArray(name.CN) ? name.CN.join(", ") : name.CN;
}

/** Every serial the CA says it has signed, in the order it signed them. */
function issuedSerials(): string[] {
  const signed = pebbleLog.join("").matchAll(/Issued certificate serial ([\da-f]+)/g);
  return [...signed].map((match) => normalizedSerial(match[1]));
}

/**
 * A serial as one comparable string. The CA prints the number it signed; node
 * prints the bytes the certificate carries, and those hold a leading zero
 * whenever the first one would otherwise read as a sign — so half the time the
 * two spell the same serial differently.
 */
function normalizedSerial(serial: string): string {
  return serial.toLowerCase().replace(/^0+/, "");
}

/** One docker command, run the way an operator runs it. */
function docker(args: string[]): Promise<CommandResult> {
  return run("docker", args, REPO_ROOT, process.env as Record<string, string>);
}

function daemonLogTail(limit: number = 8000): string {
  return tail("node container logs", daemonLog.join(""), limit);
}

function pebbleLogTail(limit: number = 8000): string {
  return tail("CA container logs", pebbleLog.join(""), limit);
}

function caddyLogTail(caddy: Caddy, limit: number = 12_000): string {
  return tail(`${caddy.name} container logs`, caddy.log.join(""), limit);
}

/** The tail of a container's output, as a failure message carries it. */
function tail(what: string, text: string, limit: number): string {
  const cut = text.length <= limit ? text : `…${text.slice(-limit)}`;
  return `--- ${what} ---\n${cut}\n--- end ${what} ---`;
}
