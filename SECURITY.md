# Security and trust boundary

## Supported trust model

Scafo is for solo developers, small trusted teams, and agencies running code they control and review. One Scafo installation is one trust domain: deployed repositories, dependencies, build inputs, deployers, runtime code, and the people holding its operational credentials must be mutually trusted.

An agency-client relationship alone is not a technical trust boundary. The operator must control and review every workload that runs in an installation.

Project, operator, and OIDC scopes authorize actions and separate operations. They do not isolate hostile workloads. Do not use one installation for arbitrary customer code, public build submission, or projects whose code owners do not trust one another.

Run different trust domains in separate Scafo installations with separate buckets and host or VM security boundaries.

## What Scafo protects today

- Most node APIs authenticate signed node and operator requests. Operator roles and project scopes restrict the operations a key may perform; OIDC deploy policy binds a workload deployer to its configured project.
- `GET /.well-known/scafo/health` on the node/API listener and `GET /v1/ingress/ask` for on-demand TLS are intentionally public. `GET /v1/ingress/traefik` is intentionally unauthenticated and publishes the complete host-to-loopback routing map, so only colocated or private Traefik may reach it. `/v1/storage` uses a separate storage bearer token and must never be exposed through ingress.
- `GET /.well-known/celld/health` belongs to Celld and answers on deployed application hosts. It says that application runtime is healthy; it is not the Scafo node/API health check.
- The registry lives in a bucket and uses conditional writes to prevent lost updates. Coordinator leases and fences guard stale placement decisions and other explicitly lease-gated coordinator duties.
- The node API, runtime listeners, and operator-managed ingress are separate surfaces. Runtime listeners default to loopback; widening them requires the operator to classify the network as a private network or WireGuard transport.
- Registry and bucket state are durable; the daemon coordinates deployment and runtime processes. This is a trusted-workload boundary, not a secret or OS-isolation boundary.

## Known limitations

- Builds and runtime processes are not OS-sandboxed from the daemon or from one another.
- Ordinary Worker egress is direct. It can reach destinations visible from its network namespace, including local and internal services.
- Celld's internal operator API is mostly unauthenticated. Its safety depends on a private network or overlay; do not expose it publicly. See Celld's [security guidance](https://github.com/denoland/celld/blob/main/docs/security.md).
- Celld and fleet bucket credentials are administrative authority. Celld child processes receive fleet credentials, and Scafo provides no separate OS credential boundary against child compromise or native escape. Do not treat those credentials as isolated from trusted workload code. Celld documents the bucket as its fleet authority in its [security guidance](https://github.com/denoland/celld/blob/main/docs/security.md).
- The S3-compatible bucket is an availability boundary as well as the durable registry: it must honour conditional writes and remain reliably reachable for registry and lease traffic. Intermittent latency or errors can prevent a Celld node lease from renewing; that process self-fences, exits, and restarts. Scafo does not turn an unreliable object store into a highly available control plane. Celld 0.4.0 also waits a full third of the lease lifetime after an ambiguous renewal reads back the unchanged prior lease. Two missed attempts can therefore fence a node even when the store recovers before the lease expires. Track the upstream fix in [Celld issue #182](https://github.com/denoland/celld/issues/182).
- Deploy admission bounds compressed and expanded artifact bytes, archive entries, retained builder output, node and project concurrency and queue depth, node and project staged bytes, and receive, queue, and task deadlines. These configurable application-level limits are not OS isolation and do not admit work against available memory; apply external host or container limits for CPU, memory, processes, filesystem use, and networking.
- On `SIGINT` or `SIGTERM`, `scafo sail` closes deploy admission, cancels staged, queued, and active deploy work, joins builder process-group cleanup, then drains supervised runtimes. Manual `scafo sail` remains development-only for abrupt-death containment: an uncatchable bare-host daemon death can orphan Celld or esbuild descendants that hold fleet credentials. Production bare hosts must use the installer's systemd unit or an equivalent cgroup-owning supervisor: it must TERM the daemon first, hard-kill remaining members of its one non-delegated cgroup, including builders, on daemon exit or timeout, and allow at least 50 seconds for the coordinated shutdown. If Celld's `CELLD_SHUTDOWN_TOTAL_MS` is raised, the enclosing grace must be at least 10 seconds larger than that value.
- The image relies on its direct Node entrypoint as container process 1 in a private PID namespace; do not use a host PID namespace or a persistent wrapper. The Kubernetes manifest makes the same boundary explicit with `hostPID: false` and `shareProcessNamespace: false`. Physical-host failure remains outside process-code guarantees.
- Application authentication, public TLS, and ingress policy remain operator responsibilities. Celld likewise requires an operator to protect its public application surface and terminate TLS where needed; see its [security guidance](https://github.com/denoland/celld/blob/main/docs/security.md).

## Deploy safely

- Keep node-to-node, runtime-peer, and operator traffic on a private network or encrypted overlay. Expose only the ingress endpoints intended for application traffic.
- Give each installation one narrowly scoped bucket and protect bucket, node, storage-token, and deployment credentials as administrative secrets.
- Choose an object store with conditional-write semantics and reliable, low-latency access from every node; test its failure behaviour before relying on it for production traffic.
- Use external host, VM, or container resource controls for CPU, memory, process, filesystem, network, and cleanup limits.
- Configure upstream runtime policy through `runtime.celldEnv`, `--celld-env`, or `SCAFO_CELLD_ENV`; Scafo supplies no Celld policy defaults.
- Celld 0.4.0 operators whose store has intermittent multi-second stalls may opt into `CELLD_TTL_MS=30000`. Set it consistently on every Scafo node. This makes Celld renew every 10 seconds and gives short interruptions more absolute recovery margin, but an unplanned node failure can then take up to 30 seconds to become eligible for takeover. Scafo deliberately preserves Celld's 10-second default when the variable is absent. Re-evaluate this workaround when adopting a release that fixes Celld issue #182.
- Use separate installations, buckets, and host or VM boundaries for different trust domains.
- Pin and review the Scafo build you deploy, and use a current supported Celld release. Re-read Celld's [security](https://github.com/denoland/celld/blob/main/docs/security.md), [limitations](https://github.com/denoland/celld/blob/main/docs/limitations.md), and [Cloudflare compatibility](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md) notes before upgrading.

## Celld boundary

Scafo requires Celld 0.4.0 and gives each environment its own Celld fleet. Celld owns deployment adoption, application health, cells, and resource policy inside that fleet; Scafo does not replace those controls.

Celld currently exposes one current application deployment per fleet. A later deploy replaces what its environment serves. Earlier artifacts may remain in the bucket, but Scafo deliberately adds no old-build routing or historical deployment selector over them. Track the upstream lifecycle work in [Celld issue #181](https://github.com/denoland/celld/issues/181).

Celld is alpha software. Security fixes apply only to its latest release; older alpha releases receive none. Its [security guidance](https://github.com/denoland/celld/blob/main/docs/security.md) and [limitations](https://github.com/denoland/celld/blob/main/docs/limitations.md) define the runtime boundary. Scafo composes projects and environments above Celld, but does not provide stronger isolation for hostile code. Review those upstream documents before every upgrade.

Scafo does not add a raw TCP bridge or transparent tunnel to work around missing Celld APIs. Upstream secure internal APIs or typed outbound HTTP/WS mediation could be considered for a first-party implementation only after explicit security review.

## Deferred isolation work

Hostile workload isolation is not available. Do not infer it from authorization scopes, deployment separation, or ingress routing.
