# scafo

Self-hosted serverless deployment platform for JS apps.

> ⚠️ Work in progress — not yet published.

Its state is a registry of JSON objects in an S3-compatible bucket, mutated only
through conditional writes. There is no database and no consensus protocol, and
a single binary is both the node daemon and the CLI.

## Vocabulary

A **scafo fleet** is one installation: one registry and the **scafo nodes**
(machines running its daemon) joined to it. Each scafo node may supervise
multiple **celld nodes** (application processes); celld groups those processes
by application deployment into its own **celld fleets**. Unqualified `fleet`
and `node` in these docs mean the scafo layer.

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

node dist/cli/index.mjs operator keygen --register
node dist/cli/index.mjs deploy ./my-app --node http://127.0.0.1:7400 \
  --project shop --env production

curl -H 'Host: shop.scafo.test' http://127.0.0.1
```

The application is reachable at `<project>--<env>.scafo.test`, at
`shop.scafo.test` for the `production` environment, and at any custom domains
claimed for that environment. Nothing resolves those names for you — send the
`Host` header, or add them to `/etc/hosts`.

The node/API listener reports Scafo itself at
`/.well-known/scafo/health`. A deployed application's host reports its Celld
runtime at `/.well-known/celld/health`; these are deliberately separate
surfaces.

Scafo follows Celld 0.4.0's current-deployment model: a new deploy becomes the
environment's current deployment. Previous artifacts may remain in the bucket,
but Scafo does not expose old-build hosts or a historical deployment selector. Follow
[Celld issue #181](https://github.com/denoland/celld/issues/181) for the upstream
lifecycle discussion. See [SECURITY.md](./SECURITY.md) for the trust boundary and
links to Celld's current security and limitation notes.

Celld 0.4.0 also has a known node-lease retry limitation under intermittent
object-store failures. Scafo keeps Celld's upstream lease default unchanged;
operators who accept slower failure detection for more interruption tolerance
can opt into `CELLD_TTL_MS=30000`. See the exact tradeoff in
[SECURITY.md](./SECURITY.md#deploy-safely) and follow
[Celld issue #182](https://github.com/denoland/celld/issues/182).

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
  (`build/`) until there are. wireguard-tools it deliberately leaves to your
  package manager: a tunnel needs a kernel module and `NET_ADMIN`.

  **The ingress it installs is scafo-caddy by default** — Caddy built with the
  [`caddy.storage.scafo`](https://github.com/sandros94/scafo-certmagic) module,
  which keeps the certificates, their keys and the ACME account _in the bucket_
  and reaches them through this node's own `/v1/storage`. That is what lets
  every node in a fleet serve one certificate instead of each issuing its own
  for the same names. It holds no bucket credential: a loopback URL and a bearer
  token, and nothing else. `SCAFO_INSTALL_CADDY=plain` opts down to upstream
  Caddy, pinned in the script, with certificates on that host — per-node TLS,
  correct for one host and a rate limit waiting to happen on a fleet. Either one
  is installed as `caddy`, so nothing else on the host knows which it is;
  `SCAFO_CADDY_BASE` and `SCAFO_CADDY_SHA256` are its base URL and its pin, the
  same integrity-by-default, authenticity-by-pin posture `scafo`'s own binary
  has. **There is no scafo-caddy release yet either**, so until there is, the
  default path fails with a message naming `SCAFO_INSTALL_CADDY=plain`, or point
  `SCAFO_CADDY_BASE` at your own `xcaddy build` output.

  The storage token is where that gets interesting. The node mints it `0600`
  inside a `0700` directory it owns, and the ingress runs as another user that
  cannot read it — and neither mode is loosened. The unit uses systemd's
  `LoadCredential=`, which has the service manager read the file _as root_ and
  hand the service a private read-only copy in `$CREDENTIALS_DIRECTORY`; the
  config's `token_file` points at that copy. On a host's very first boot the
  token does not exist yet, so the ingress fails and retries (`243/CREDENTIALS`,
  with the start rate limit turned off) until the node has minted it — seconds,
  normally. That is the design, and the unit says so in a comment.

- **Undoing that:** [`scripts/uninstall.sh`](./scripts/uninstall.sh) — the same
  list, backwards. It stops the ingress, gives the node the full grace it needs
  to drain, then removes both units, the four executables and `/etc/scafo`, and
  **keeps `/var/lib/scafo`**: the key pair this node's registry record names and
  the token the ingress presents to `/v1/storage`, neither of which anything can
  reissue. `--purge` takes those too, with Caddy's certificates, its ACME account
  and the system users that install created; `--dry-run` prints what either would
  remove and touches nothing at all. It reads which Caddy the install used out of
  the manifest, because that changes what `--purge` _means_: under plain Caddy
  the certificates were on that host and go with it, and under scafo-caddy they
  were never there — they are in the bucket, and the report says so.

  ```sh
  sudo sh scripts/uninstall.sh --dry-run   # then again without it, or with --purge
  ```

  **Neither of them goes near the bucket.** The registry is the fleet's, not one
  host's, and a node that has stopped needs no cleanup: it marks itself draining
  on the way out and placement counts it out on the coordinator's next pass.
  Retiring what it served is `scafo env`, from anywhere.

- **The binary:** `pnpm compile` — `deno compile` over the same `dist/` the image
  runs, producing `build/scafo-linux-amd64` and `build/scafo-linux-arm64` with a
  `.sha256` beside each. celld, an ingress and wireguard-tools stay separate
  prerequisites; the binary carries none of them.
- **The node image:** `docker build -t scafo .` — the daemon, celld and esbuild in
  one image. `ENTRYPOINT` is the CLI, so `docker run scafo sail --listen 0.0.0.0:7400`
  is the whole invocation. Keep that direct Node entrypoint as container process 1
  in a private PID namespace: do not use host PID mode or a persistent wrapper,
  because container lifecycle containment removes remaining descendants, including
  in-flight builders, after an abrupt daemon death. **Give it a stop grace of at
  least 50 seconds**
  (`stop_grace_period: 50s`, `terminationGracePeriodSeconds: 50`): Celld 0.4's
  default shutdown may take 40 seconds, and the node needs time to coordinate it.
  If `runtime.celldEnv.CELLD_SHUTDOWN_TOTAL_MS` raises that upstream bound,
  raise the enclosing grace to at least the configured value plus 10 seconds.
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
through. The daemon and CLI lean on [h3](https://h3.dev), citty and confbox from
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
