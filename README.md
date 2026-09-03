# scafo

Self-hosted serverless deployment platform for JavaScript applications.

Scafo stores its registry as JSON objects in an S3-compatible bucket and mutates them with conditional writes. It has no database or consensus protocol. One binary provides both the node daemon and the CLI.

## Vocabulary

A Scafo fleet is one installation: one registry and its Scafo nodes (machines running `scafo sail`). A Scafo node can supervise Celld node processes for its assigned environments; each environment has its own Celld fleet. Unqualified `fleet` and `node` refer to Scafo's machine-level concepts.

## Install

Install the CLI with a package manager:

```sh
npm install --global scafo
```

For a Linux node, download the installer. It selects the latest release unless `SCAFO_VERSION` names an exact one:

```sh
curl -fsSLO https://raw.githubusercontent.com/sandros94/scafo/main/scripts/install.sh
sh install.sh
```

The container image is `ghcr.io/sandros94/scafo:<version>`.

## Quickstart

Use the self-contained playgrounds for local evaluation:

- [`playgrounds/single-node/`](./playgrounds/single-node/README.md) — deployment, routing, replacement, and observations.
- [`playgrounds/multi-node/`](./playgrounds/multi-node/README.md) — coordination, placement, cell ownership, and draining.

They use mock `*.scafo.test` hosts and a SeaweedFS container as the S3-compatible store. They do not require external DNS or cloud credentials.

`/.well-known/scafo/health` is the Scafo node/API health endpoint. `/.well-known/celld/health` is the deployed application's Celld health endpoint.

## Production use

- **Linux host:** [`scripts/install.sh`](./scripts/install.sh) downloads and SHA-256 verifies Scafo, Celld, Caddy, and esbuild, then writes systemd units and `/etc/scafo` when run as root. It does not start a node; configure bucket credentials first.

  The default ingress is `scafo-caddy`, built from [scafo-ingress](https://github.com/sandros94/scafo-ingress). It carries two Caddy modules: `caddy.storage.scafo` keeps certificates, ACME account material, and locks in the bucket through the node's loopback `/v1/storage` API, and `http.reverse_proxy.upstreams.scafo` reads the fleet's routing from the node's `/v1/ingress/routes` and resolves each request's host to the processes currently running for it. Caddy pulls, the way Traefik does; the node configures no ingress. It receives only the node's ingress bearer token, not bucket credentials. `wireguard-tools` remains an operating-system prerequisite.

  The ingress token is owner-readable state. The installed Caddy unit receives it through systemd `LoadCredential=`; it may initially retry until the node creates the token.

- **Uninstall:** [`scripts/uninstall.sh`](./scripts/uninstall.sh) removes units, executables, and `/etc/scafo`, while preserving `/var/lib/scafo` by default. `--purge` also removes local state; `--dry-run` changes nothing. Neither mode changes bucket data.

- **Binary:** `pnpm compile` produces `build/scafo-linux-amd64` and `build/scafo-linux-arm64`, each with a `.sha256` file. Celld, an ingress, and WireGuard tools are separate prerequisites.

- **Image:** `ghcr.io/sandros94/scafo:<version>` includes Scafo, Celld, and esbuild. `:edge` tracks every commit on `main`; version tags are releases. Nodes need esbuild only to bundle Worker entries; `scafo deploy --no-bundle` ships a pre-bundled entry and skips it. Keep the direct Node entrypoint as PID 1 in a private PID namespace; do not use host PID mode or a persistent wrapper. Configure at least 50 seconds of shutdown grace. If `CELLD_SHUTDOWN_TOTAL_MS` is set, use that value plus at least 10 seconds.

- **Production examples:** [`examples/compose.yaml`](./examples/compose.yaml) and [`examples/k3s/`](./examples/k3s/) use external S3-compatible storage and real DNS. A fleet runs the same node on each host against the same bucket and prefix.

## Security

Read [SECURITY.md](./SECURITY.md) before production use. It defines the trusted workload model, public and private API surfaces, Celld limitations, bucket and lease requirements, and deployment containment requirements.

Celld 0.4.0 has a lease-retry limitation during intermittent object-store failures. Scafo preserves Celld's default. `CELLD_TTL_MS=30000`, set consistently on every node, is an optional workaround with slower failure detection; see [Deploy safely](./SECURITY.md#deploy-safely) and [Celld issue #182](https://github.com/denoland/celld/issues/182).

## Development

<details>

<summary>local development</summary>

- Clone this repository.
- Install Node.js `>=24.17.0`.
- Enable Corepack with `corepack enable`.
- Run `pnpm install`.
- Run `pnpm build`.
- Run `pnpm test`.
- Run `pnpm lint`.
- Run `pnpm typecheck`.

</details>

## Credits

[Celld](https://github.com/denoland/celld) provides application runtime; [Caddy](https://caddyserver.com) and [Traefik](https://traefik.io) provide ingress; and [WireGuard](https://www.wireguard.com) provides private network transport. [H3](https://h3.dev), [citty](https://github.com/unjs/citty), and [confbox](https://github.com/unjs/confbox) support the API and CLI; [unjwt](https://github.com/sandros94/unjwt), [uns3](https://github.com/sandros94/uns3), and [tar](https://github.com/isaacs/node-tar) support authentication, storage, and archives; [esbuild](https://esbuild.github.io) bundles Worker entries on the node; [tavolato](https://github.com/sandros94/tavolato) renders CLI tables.

## License

[Apache-2.0](./LICENSE)
