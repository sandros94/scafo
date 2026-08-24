/*
 * The TLS-storage loop end to end: a Caddy carrying the `caddy.storage.scafo`
 * module obtains a REAL certificate from a real ACME CA and keeps everything
 * that issuance produced — the certificate, its private key, the account key,
 * and the locks that serialized the work — in the installation's bucket, reached
 * only through this node's `/v1/storage` surface and the token guarding it.
 *
 * THE POINT IS THAT CADDY HOLDS NO BUCKET CREDENTIAL. It is given a URL and a
 * token file and nothing else, and the node on the other side of that URL is the
 * only process here that can address the bucket at all. So the loop below is the
 * shortest one that could only pass if the whole path works: an ACME CA that
 * really validates a challenge, a certificate that really chains to that CA's
 * root, keys that are really in the bucket, and a SECOND Caddy given the same
 * two values that serves the SAME certificate — which it can only have loaded
 * from shared storage, because re-issuing would have produced another one.
 *
 * The topology differs from every other end-to-end suite here, and the reason is
 * DNS. The others put their containers on the default bridge and address each
 * other by address on it, because nothing in them has to resolve a name. This
 * one does: the CA validates a challenge by connecting to the name it is issuing
 * for, so that name has to resolve to Caddy, and only a user-defined network has
 * a resolver behind it. So the containers share one, and the first Caddy carries
 * the site name as a network alias — aliases may hold dots, and docker's
 * embedded DNS answers for them, which is the whole mechanism. The store stays
 * on the bridge where the harness puts it, and the daemon — attached to both — is
 * what bridges the two.
 *
 * Pebble is the CA. It is configured to run its validation ports on 80 and 443
 * so that a challenge lands on Caddy's real ports rather than a test-only pair,
 * told not to sleep between validation attempts, and told not to reject nonces
 * at random, which it does by default and which would only ever make this suite
 * slower or flakier without proving anything.
 *
 * Skipped unless SCAFO_E2E=1. The Caddy image carrying the module is chosen with
 * SCAFO_E2E_CADDY_IMAGE:
 *
 *   SCAFO_E2E=1 pnpm vitest run test/integration/e2e-tls.test.ts
 */

import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
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
  buildRepo,
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
 * Caddy with the `caddy.storage.scafo` module compiled in. The published image
 * is the default; point this at a locally built tag to run the suite against a
 * module that is not released yet.
 */
const CADDY_IMAGE: string =
  process.env.SCAFO_E2E_CADDY_IMAGE ?? "ghcr.io/sandros94/scafo-caddy:edge";

/** The ACME test CA. It mints a fresh issuance chain on every start. */
const PEBBLE_IMAGE = "ghcr.io/letsencrypt/pebble:latest";

const CADDY_HTTPS_PORT = 443;
const CADDY_ADMIN_PORT = 2019;
/** Where the CA's other challenge would land; nothing here listens on it. */
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

/** Where the node keeps its identity, and where it mints the storage token. */
const NODE_STATE_DIR = "/var/lib/scafo-tls";
/** The two files a Caddy is given, and the only two it needs. */
const TOKEN_IN_CADDY = "/etc/scafo/storage-token";
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

const PLATFORM_DOMAIN = "scafo.test";
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
let storageToken: string;
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
    await buildRepo();

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
        /* Validation is a local hop here, so the random delay a real CA models
           is only a way to make this suite slower. */
        PEBBLE_VA_NOSLEEP: "1",
        /* Pebble rejects 5% of good nonces by default to exercise a client's
           retry path. That path is not what is under test, and its only effect
           here would be an occasional slower issuance. */
        PEBBLE_WFE_NONCEREJECT: "0",
      })
      .withExposedPorts(PEBBLE_PORT, PEBBLE_MANAGEMENT_PORT)
      .withLogConsumer((stream: Readable) => {
        stream.on("data", (chunk) => pebbleLog.push(String(chunk)));
        stream.on("err", (chunk) => pebbleLog.push(String(chunk)));
      })
      .withWaitStrategy(Wait.forLogMessage(/ACME directory available at/))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    /*
     * TWO DIFFERENT ROOTS, and confusing them is the easy mistake here. The one
     * shipped in the image signs Pebble's OWN certificate, which is what Caddy
     * has to trust to talk to the directory at all. The one fetched from the
     * management interface is the chain Pebble ISSUES under, minted fresh on the
     * start above, and is what the certificate served at the end must verify
     * against.
     */
    directoryRoot = shipped.directoryRoot;
    issuanceRoot = await pebbleIssuanceRoot(
      pebble.getMappedPort(PEBBLE_MANAGEMENT_PORT),
      directoryRoot,
    );

    daemon = await new GenericContainer(NODE_IMAGE)
      /* On the user-defined network for Caddy to reach it by name, and on the
         bridge — where an aliased container is attached anyway — for the store. */
      .withNetwork(network)
      .withNetworkAliases(NODE_ALIAS)
      .withBindMounts([{ source: REPO_ROOT, target: "/work", mode: "rw" }])
      .withWorkingDir("/work")
      .withEnvironment({
        ...storeEnv(store.fromContainers, BUCKET),
        SCAFO_NODE_ID: NODE_ID,
        SCAFO_TRANSPORT: "none",
        SCAFO_STATE_DIR: NODE_STATE_DIR,
        SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
        SCAFO_ADVERTISE: `127.0.0.1:${String(NODE_PORT)}`,
        SCAFO_BIND_HOST: "0.0.0.0",
        ESBUILD_BINARY_PATH: "/usr/local/bin/esbuild",
        /* No ingress: this node routes nothing, it only holds the bucket. What
           terminates TLS here is the Caddy beside it, which is the point. */
      })
      .withCommand([
        "node",
        "dist/cli/index.mjs",
        "sail",
        "--listen",
        `0.0.0.0:${String(NODE_PORT)}`,
      ])
      .withExposedPorts(NODE_PORT)
      .withLogConsumer((stream: Readable) => {
        stream.on("data", (chunk) => daemonLog.push(String(chunk)));
        stream.on("err", (chunk) => daemonLog.push(String(chunk)));
      })
      .withWaitStrategy(Wait.forLogMessage(/listening on/))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    apiPort = daemon.getMappedPort(NODE_PORT);
    storageToken = await readStorageToken();

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
      /* The operator's whole handoff, said once: where the file is. Everything
         below rests on it, because it is the only thing the ingress is given
         besides a URL — and the reason it needs no bucket credential. */
      expect(daemonLog.join(""), daemonLogTail()).toContain(
        `storage token at ${NODE_STATE_DIR}/storage-token`,
      );
      expect(storageToken.length).toBeGreaterThan(0);
      observed.tokenLength = storageToken.length;
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

      /*
       * Verified rather than merely inspected: the handshake was made with the
       * CA's issuance root as the ONLY trusted root and hostname checking left
       * on, so reaching this line already means the certificate chains to the CA
       * and is valid for the name. What is read off it below is the detail.
       */
      expect(answer.cert.subjectaltname).toContain(`DNS:${SITE}`);
      expect(commonName(answer.cert.issuer)).toMatch(/^Pebble Intermediate CA/);
      expect(chainSubjects(answer.cert).join(" | ")).toMatch(/Pebble Intermediate CA/);

      issuedSerial = answer.cert.serialNumber;

      /*
       * It was ISSUED, not conjured: the ingress asked, the CA connected back to
       * this container over the challenge it was offered, and the serial the CA
       * says it signed is the serial the handshake just presented.
       */
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
    "kept every byte of that issuance in the bucket, through the node",
    async () => {
      const keys = await storageList();
      const certificates = keys.filter((key) => key.startsWith(CERTIFICATES_PREFIX));
      const account = keys.filter((key) => key.startsWith(ACCOUNT_PREFIX));

      /* The certificate, its private key and the metadata beside it, plus the
         ACME account the order was placed under — none of which Caddy could
         have written anywhere else, because it was given nowhere else. */
      expect(certificates.some((key) => key.endsWith(".crt"))).toBe(true);
      expect(certificates.some((key) => key.endsWith(".key"))).toBe(true);
      expect(account.some((key) => key.endsWith(".key"))).toBe(true);

      const certKey = certificates.find((key) => key.endsWith(".crt"));
      expect(certKey, `no certificate among ${JSON.stringify(keys)}`).toBeDefined();

      const stored = await storageGet(certKey ?? "");
      const parsed = new X509Certificate(stored);
      expect(parsed.subjectAltName).toContain(`DNS:${SITE}`);
      /* The same certificate, not merely a certificate: the serial ties what the
         bucket holds to what the handshake above presented. */
      expect(parsed.serialNumber).toBe(issuedSerial);

      /*
       * And it is really IN THE BUCKET rather than somewhere in the node: read a
       * second time straight out of the store, with the credential Caddy does
       * not have, and the two must be the same bytes.
       */
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

      /* Answered by the OTHER container — the body says which — with the SAME
         certificate. A Caddy that had re-issued would be serving a certificate
         of its own, and its serial is the one thing it could not have copied. */
      expect(answer.status).toBe(200);
      expect(answer.body).toBe(servedBody(second.name));
      expect(answer.cert.serialNumber).toBe(issuedSerial);

      /*
       * Said from both other sides too. This Caddy never began an issuance — the
       * line its predecessor logged before going to the CA is absent from its own
       * output — and the CA has still signed exactly one certificate, which is
       * the same claim made where it cannot be argued with.
       */
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
      /*
       * WHICH names certmagic locks under is its own business, so nothing here
       * asserts one. That it locked AT ALL, through this node, is visible from
       * both ends: the ingress says it took a lock and gave it back, and the
       * bucket has no record of one left.
       *
       * Serialization itself is asserted a test earlier and from the far side —
       * the ingress runs two managers for this name, both of which asked for the
       * lock, and the CA still signed exactly once.
       */
      const log = caddies[0].log.join("");
      expect(log, caddyLogTail(caddies[0])).toContain('"msg":"acquiring lock"');
      expect(log, caddyLogTail(caddies[0])).toContain('"msg":"lock acquired"');
      expect(log, caddyLogTail(caddies[0])).toContain('"msg":"releasing lock"');

      /* Polled rather than read once: a lock is one record, a release removes
         it, and the maintenance a freshly started Caddy runs holds one of its
         own for as long as that takes. What must not survive is any of them. */
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
    "answers a caller presenting the wrong token, or none, with 401",
    async () => {
      const wrong = await send(
        apiPort,
        "/v1/storage/list?prefix=&recursive=true",
        "GET",
        { authorization: `Bearer ${storageToken}-not` },
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
      /* Read once at provision, so an unreadable one fails the start loudly
         rather than surfacing later as a certificate that never arrives. */
      { content: `${storageToken}\n`, target: TOKEN_IN_CADDY, mode: 0o600 },
      { content: directoryRoot, target: DIRECTORY_ROOT_IN_CADDY },
    ])
    .withCommand(["caddy", "run", "--config", CONFIG_IN_CADDY])
    .withExposedPorts(CADDY_HTTPS_PORT, CADDY_ADMIN_PORT)
    .withLogConsumer((stream: Readable) => {
      stream.on("data", (chunk) => log.push(String(chunk)));
      stream.on("err", (chunk) => log.push(String(chunk)));
    })
    /* The configuration is served only after every module has provisioned, and
       the storage module provisions by reading the token file — so this line is
       also the proof that the two values it was given were usable. */
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
 * ONLY THE TLS-ALPN CHALLENGE. Both would work, and the CA is configured for
 * both ports, but leaving the HTTP one enabled means the first attempt goes to a
 * port this server does not listen on, which costs a retry and proves nothing.
 */
function caddyConfig(name: string): string {
  return JSON.stringify(
    {
      admin: {
        listen: `0.0.0.0:${String(CADDY_ADMIN_PORT)}`,
        origins: [`127.0.0.1:${String(CADDY_ADMIN_PORT)}`, `localhost:${String(CADDY_ADMIN_PORT)}`],
      },
      storage: {
        module: "scafo",
        endpoint: `http://${NODE_ALIAS}:${String(NODE_PORT)}`,
        token_file: TOKEN_IN_CADDY,
      },
      apps: {
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
              ],
              /* Nothing listens on 80 here, and nothing needs to: the challenge
                 that is left enabled is served on the TLS listener itself. */
              automatic_https: { disable_redirects: true },
            },
          },
        },
        tls: {
          /* Named explicitly rather than left to the route matcher alone, so
             issuance starts at boot and the wait below is about the CA rather
             than about whether anything asked for a certificate yet. It also
             leaves TWO managers asking for the same name — this one and the
             matcher's — so a second caller really does arrive at the issuance
             lock while the first holds it, and the CA is still asked once. */
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

/** The node's storage token, read out of the state directory it was minted in. */
async function readStorageToken(): Promise<string> {
  const read = await daemon.exec(["cat", `${NODE_STATE_DIR}/storage-token`]);
  expect(read.exitCode, `${read.output}\n${daemonLogTail()}`).toBe(0);
  return read.output.trim();
}

/** Every key the node is storing, as the surface answers it. */
async function storageList(): Promise<string[]> {
  const answer = await send(
    apiPort,
    "/v1/storage/list?prefix=&recursive=true",
    "GET",
    { authorization: `Bearer ${storageToken}` },
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
    { authorization: `Bearer ${storageToken}` },
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
  /** The ONLY root trusted for the connection; verification stays on. */
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
    /* The last certificate in a chain points at itself; that is where it ends. */
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
