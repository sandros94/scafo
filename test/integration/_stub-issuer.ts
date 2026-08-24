/*
 * A stand-in for a CI provider's OIDC issuer, for the end-to-end suites.
 *
 * It is a container so that the node daemon reaches it the way it reaches the real
 * thing: over the network, by the URL the token names in `iss`, through its own
 * discovery document and key set. Nothing about the verification path is stubbed
 * — only the provider is.
 *
 * The keypair is generated in the test process. The container is given the
 * PUBLIC half alone, so the signing key never leaves the process that mints the
 * tokens, exactly as it never leaves a real provider.
 */

import type { JWK_RSA_Private, JWK_RSA_Public, JWKSet } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { sign as signJws } from "unjwt/jws";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

/** Small, and already node 24: the same runtime the daemon runs on. */
export const STUB_ISSUER_IMAGE: string = "node:24-slim";

/** Port the stub listens on inside its container. */
export const STUB_ISSUER_PORT: number = 8080;

/** Path the key set is served at; the discovery document points here. */
export const STUB_JWKS_PATH: string = "/jwks";

const KID = "stub-issuer-1";

export interface StubIssuer {
  container: StartedTestContainer;
  /**
   * The `iss` every token carries, and the URL the daemon runs discovery
   * against. An address on the docker bridge, because the daemon has no resolver
   * that knows this container by name.
   */
  iss: string;
  /** The public half, exactly as the container serves it. */
  publicKey: JWK_RSA_Public<"RS256">;
  /**
   * Mints a workload token. The claims are GitHub-shaped by default; anything
   * passed in overrides them, which is how the negative cases are built.
   */
  mint(claims: Record<string, unknown>): Promise<string>;
  stop(): Promise<void>;
}

export interface StartStubIssuerOptions {
  /** Docker network the returned {@link StubIssuer.iss} addresses the container on. */
  network: string;
  startupTimeoutMs?: number;
}

/**
 * Starts the issuer and waits until it answers discovery.
 *
 * The server is copied in as a file rather than passed as `node -e`, so what it
 * does is readable here and the container's command stays one word.
 */
export async function startStubIssuer(opts: StartStubIssuerOptions): Promise<StubIssuer> {
  const {
    privateKey,
    publicKey,
  }: { privateKey: JWK_RSA_Private<"RS256">; publicKey: JWK_RSA_Public<"RS256"> } =
    await generateJWK("RS256", { kid: KID });

  const container = await new GenericContainer(STUB_ISSUER_IMAGE)
    .withCopyContentToContainer([{ content: SERVER_JS, target: "/srv/issuer.mjs" }])
    .withEnvironment({
      /* The key set as the container will serve it, public half only. */
      STUB_JWKS: JSON.stringify({ keys: [publicKey] } satisfies JWKSet),
      STUB_PORT: String(STUB_ISSUER_PORT),
      STUB_JWKS_PATH,
    })
    .withCommand(["node", "/srv/issuer.mjs"])
    .withExposedPorts(STUB_ISSUER_PORT)
    .withWaitStrategy(
      Wait.forHttp("/.well-known/openid-configuration", STUB_ISSUER_PORT).forStatusCode(200),
    )
    .withStartupTimeout(opts.startupTimeoutMs ?? 120_000)
    .start();

  const iss = `http://${container.getIpAddress(opts.network)}:${String(STUB_ISSUER_PORT)}`;

  return {
    container,
    iss,
    publicKey,
    async mint(claims) {
      const iat = Math.floor(Date.now() / 1000);
      const payload = {
        iss,
        aud: "scafo",
        iat,
        /* Long enough to outlive a whole deploy, which polls with the same
           token: an OIDC token is not single-use the way a node token is. */
        exp: iat + 3600,
        ...claims,
      };
      return signJws(payload, privateKey, { alg: "RS256", protectedHeader: { kid: KID } });
    },
    async stop() {
      await container.stop().catch(() => {});
    },
  };
}

/**
 * The issuer itself: the two documents an OIDC verifier asks for, and 404 for
 * everything else. `issuer` in the discovery document is built from the `Host`
 * header, so it matches whichever address the caller reached it by.
 */
const SERVER_JS = `import { createServer } from "node:http";

const jwks = process.env.STUB_JWKS;
const port = Number(process.env.STUB_PORT);
const jwksPath = process.env.STUB_JWKS_PATH;

createServer((request, response) => {
  const url = new URL(request.url, \`http://\${request.headers.host}\`);
  const issuer = \`http://\${request.headers.host}\`;

  const body =
    url.pathname === "/.well-known/openid-configuration"
      ? JSON.stringify({
          issuer,
          jwks_uri: \`\${issuer}\${jwksPath}\`,
          response_types_supported: ["id_token"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        })
      : url.pathname === jwksPath
        ? jwks
        : null;

  if (body === null) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not_found"}');
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(body);
}).listen(port, "0.0.0.0", () => console.log("stub issuer listening on " + port));
`;
