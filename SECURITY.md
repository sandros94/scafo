# Security and trust boundary

## Trust model

One Scafo installation is one trusted workload domain. Repositories, dependencies, build inputs, deployers, runtime code, and operational credential holders must trust one another. Application, operator, and OIDC scopes authorize actions; they do not isolate hostile workloads.

Do not use one installation for arbitrary customer code, public build submission, or mutually untrusted applications. Use separate installations, buckets, and host or VM boundaries for separate trust domains.

## Protected surfaces

- Node and operator API requests use signed tokens. Operator roles and application scopes limit actions; OIDC deploy policy binds a workload deployer to an application.
- `/.well-known/scafo/health` is intentionally public. `/v1/ingress/routes` and `/v1/storage` are the ingress's only privileged surfaces: the routing reveals every node's address for every host, and storage carries private keys in both directions. Both live on the node's own listener and require its ingress bearer token, which is all the ingress ever holds. The ingress enforces the rest of that boundary itself: it never proxies either prefix through the public platform API apex.
- `/.well-known/celld/health` is the application runtime health endpoint, not the Scafo node/API health endpoint.
- Registry conditional writes prevent lost updates. Coordinator leases and fences protect stale placement decisions and other lease-gated work.
- Node API and runtime listeners default to loopback. Wider binds require an explicit private-network or WireGuard transport decision.

## Limitations

- Builds and runtime processes are not OS-sandboxed from the daemon or each other. Worker egress, HTTP and raw TCP through `cloudflare:sockets` alike, can reach any address visible to its network namespace.
- Celld's internal operator API is mostly unauthenticated. Keep it on a private network or overlay; do not expose it publicly. See Celld's [security guidance](https://github.com/denoland/celld/blob/main/docs/security.md).
- Celld and bucket credentials are administrative authority. Celld child processes receive fleet credentials; Scafo provides no OS credential boundary against trusted-workload compromise or native escape.
- The bucket is both durable registry and availability boundary. It must support conditional writes and ranged reads, and provide reliable, low-latency lease traffic. Scafo cannot make an unreliable object store highly available.
- Deploy admission bounds artifact bytes and entries, retained builder output, node/application concurrency and queue depth, staged bytes, and receive/queue/task deadlines. These are scheduling bounds, not OS resource admission. Apply host or container CPU, memory, process, filesystem, and network limits.
- `scafo sail` closes deploy intake, cancels deploy work, joins builder cleanup, then drains runtimes on `SIGINT`/`SIGTERM`. For bare-host production, use the installer systemd unit or an equivalent cgroup-owning supervisor that terminates the daemon first, removes remaining builders on exit or timeout, and allows at least 50 seconds of shutdown grace. If `CELLD_SHUTDOWN_TOTAL_MS` is larger, allow at least 10 additional seconds.
- In containers, keep the direct Node entrypoint as PID 1 in a private PID namespace. Do not use host PID mode or a persistent wrapper. Physical-host failure remains outside process-code guarantees.
- Application authentication, public TLS, and ingress policy remain operator responsibilities.

## Deploy safely

- Keep node, runtime-peer, and operator traffic on a private network or encrypted overlay. Publish only intended application ingress endpoints.
- Protect bucket, node, ingress-token, and deployment credentials as administrative secrets. Use a bucket scoped to one installation.
- Test object-store conditional writes, latency, and failure behavior before production use.
- Configure Celld runtime policy through `runtime.celldEnv`, `--celld-env`, or `SCAFO_CELLD_ENV`; Scafo adds no Celld policy defaults.
- Change `CELLD_TTL_MS` consistently on every Scafo node. A runtime process renews every third of the lifetime and retries a failed renewal inside what remains of it; an unplanned takeover waits up to the lifetime.
- Pin and review the Scafo build and current Celld release. Review Celld's [security](https://github.com/denoland/celld/blob/main/docs/security.md), [limitations](https://github.com/denoland/celld/blob/main/docs/limitations.md), and [Cloudflare compatibility](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md) notes before upgrading.

## Celld boundary

Scafo requires Celld 0.5.0 — `scafo sail` runs `celld --version` at start and refuses an older binary — and creates one Celld fleet per application, served by one Celld release at a time: an upgrade stops every node first, except between releases `src/core/registry/_celld-contract.ts` lists as a rolling pair upstream declared, whose nodes may be replaced one at a time. Celld owns deployment adoption, application health, cells, and runtime resource policy; Scafo owns registry, authorization, placement, supervision, deploy intake, and the routing every ingress reads.

Celld exposes one current deployment per fleet. Scafo records a monotonic deployment revision, not a selected version; it provides no old-build routing or historical deployment selector. See [Celld issue #181](https://github.com/denoland/celld/issues/181).

Scafo does not add a raw TCP bridge or transparent tunnel around missing Celld APIs. Hostile workload isolation is not available; do not infer it from scopes, deployment separation, or ingress routing.
