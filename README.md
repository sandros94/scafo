# scafo

Self-hosted serverless deployment platform for JS apps.

> ⚠️ Work in progress — not yet published.

Its state is a registry of JSON objects in an S3-compatible bucket, mutated only
through conditional writes. There is no database and no consensus protocol, and
a single binary is both the node agent and the CLI.

## Quickstart

A whole installation on one host — a bucket, one node, and the Caddy it routes
through — from a checkout:

```sh
pnpm install && pnpm build
docker compose -f examples/compose.yaml up --build -d
```

Then mint an operator key and deploy something. The key lands in
`./scafo-operator.json`, which is where `deploy` looks for it:

```sh
export SCAFO_S3_ENDPOINT=http://127.0.0.1:8333 SCAFO_S3_BUCKET=scafo \
       SCAFO_S3_ACCESS_KEY=scafo SCAFO_S3_SECRET_KEY=scafo-secret

node dist/cli/index.mjs keygen --register
node dist/cli/index.mjs deploy ./my-app --agent http://127.0.0.1:7400 \
  --project shop --env production --flip

curl -H 'Host: shop.scafo.test' http://127.0.0.1
```

The application is reachable at `<project>--<env>.scafo.test`, at
`shop.scafo.test` for the `production` environment, and at
`<project>--<build>.scafo.test` for every build that is running. Nothing resolves
those names for you — send the `Host` header, or add them to `/etc/hosts`.

## Running it for real

- **One host, no containers:** [`scripts/install.sh`](./scripts/install.sh) — a
  single-binary bootstrap for a Linux host. It downloads and sha256-verifies the
  four executables a node is made of (`scafo`, celld, Caddy and the esbuild
  `celld deploy` builds with), then writes the systemd units and `/etc/scafo`
  when it is run by root. It starts nothing: fill in the bucket credentials it
  points you at first.

  ```sh
  curl -fsSL https://raw.githubusercontent.com/sandros94/scafo/main/scripts/install.sh | sh
  ```

  Read it before you run it — that is what it is written for. There are no
  releases yet, so point `SCAFO_INSTALL_BASE` at your own `pnpm compile` output
  (`build/`) until there are. Two things it deliberately leaves to you:
  wireguard-tools comes from your package manager, and the Caddy it installs is
  the plain one, which keeps its certificates on that host — a fleet sharing one
  certificate needs the `caddy.storage.scafo` build instead.

- **The binary:** `pnpm compile` — `deno compile` over the same `dist/` the image
  runs, producing `build/scafo-linux-amd64` and `build/scafo-linux-arm64` with a
  `.sha256` beside each. celld, an ingress and wireguard-tools stay separate
  prerequisites; the binary carries none of them.
- **The node image:** `docker build -t scafo .` — the agent, celld and esbuild in
  one image. `ENTRYPOINT` is the CLI, so `docker run scafo up --listen 0.0.0.0:7400`
  is the whole invocation. **Give it a stop grace of at least 35 seconds**
  (`stop_grace_period: 35s`, `terminationGracePeriodSeconds: 35`): a node drains
  its in-flight requests on the way out, and a shorter grace kills it mid-drain.
- **One host:** [`examples/compose.yaml`](./examples/compose.yaml), the stack the
  quickstart runs. Every operational rule it depends on is a comment in it.
- **Kubernetes:** [`examples/kubernetes/`](./examples/kubernetes/) — the same node
  as a Deployment with a Traefik sidecar, and a README covering what must not be
  got wrong.
- **A fleet:** run the same node on every host against the SAME bucket and prefix.
  That, and nothing else, is what makes them one installation.

## Credits

scafo stands on other people's work, and it is only fair to say so.

[celld](https://github.com/denoland/celld) is what moved this project from a year
of notes to something running — the Deno team built the runtime every
application here runs on. [Caddy](https://caddyserver.com) and
[Traefik](https://traefik.io) terminate TLS and route for the fleet, and
[WireGuard](https://www.wireguard.com) is the tunnel its nodes trust each other
through. The agent and CLI lean on [h3](https://h3.dev), citty and confbox from
the [UnJS](https://unjs.io) ecosystem, beside unjwt, uns3, esbuild and tar; the
tests stand on vitest and testcontainers, with SeaweedFS and MinIO playing the
bucket. A particular mention goes to
[certmagic-s3](https://github.com/ss098/certmagic-s3), whose small, readable
module is what convinced me that
[scafo-certmagic](https://github.com/sandros94/scafo-certmagic) was worth
building.

To everyone who maintains and contributes to these projects: thank you.

## License

[Apache-2.0](./LICENSE)
