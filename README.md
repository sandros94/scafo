<p align="center">
  <img src="./.github/assets/logo.svg" width="128" alt="">
</p>

# scafo

Self-hosted serverless deployment platform for JavaScript applications.

Scafo stores its registry as JSON objects in an S3-compatible bucket and mutates them with conditional writes. It has no database or consensus protocol. One binary provides both the node daemon (`scafo sail`) and the CLI. [Celld](https://github.com/denoland/celld) runs the deployed code; Caddy or Traefik pulls the fleet's routing from the node next to it.

Documentation: **[scafo.dev](https://scafo.dev)**

- [Docs](https://scafo.dev/docs) — concepts, installation, guides, operations
- [Configuration](https://scafo.dev/config) — every setting, environment variable and flag
- [Deploy](https://scafo.dev/deploy) — Docker Compose, bare metal, VPS mesh, K3s/RKE2, Coolify, Dokploy, container image
- [Reference](https://scafo.dev/reference) — CLI, node API, ingress protocol, Caddy modules, registry layout, errors

## Install

```sh
npm install --global scafo
```

Linux node: [`scripts/install.sh`](./scripts/install.sh) downloads and verifies Scafo, Celld, Caddy and esbuild, and writes systemd units and `/etc/scafo` when run as root. Container image: `ghcr.io/sandros94/scafo:<version>` (`:edge` tracks `main`).

## Quickstart

The self-contained playgrounds need no external DNS or cloud credentials:

- [`playgrounds/single-node/`](./playgrounds/single-node/README.md) — deployment, routing, replacement, observations.
- [`playgrounds/multi-node/`](./playgrounds/multi-node/README.md) — coordination, placement, cell ownership, draining.

Production recipes live in [`examples/`](./examples/README.md). The Caddy ingress is [scafo-ingress](https://github.com/sandros94/scafo-ingress).

## Security

Read [SECURITY.md](./SECURITY.md) before production use: trusted workload model, public and private API surfaces, Celld limitations, bucket and lease requirements.

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
