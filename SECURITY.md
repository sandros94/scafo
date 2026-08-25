# Security and trust boundary

## Supported trust model

Scafo is for solo developers, small trusted teams, and agencies running code they
control and review. One Scafo installation is one trust domain: deployed
repositories, dependencies, build inputs, deployers, runtime code, and the
people holding its operational credentials must be mutually trusted.

An agency-client relationship alone is not a technical trust boundary. The
operator must control and review every workload that runs in an installation.

Project, operator, and OIDC scopes authorize actions and separate operations.
They do not isolate hostile workloads. Do not use one installation for arbitrary
customer code, public build submission, or projects whose code owners do not
trust one another.

Run different trust domains in separate Scafo installations with separate
buckets and host or VM security boundaries.

## What Scafo protects today

- Most node APIs authenticate signed node and operator requests. Operator roles
  and project scopes restrict the operations a key may perform; OIDC deploy
  policy binds a workload deployer to its configured project.
- `GET /v1/health` and `GET /v1/ingress/ask` for on-demand TLS are intentionally
  public. `GET /v1/ingress/traefik` is intentionally unauthenticated and
  publishes the complete host-to-loopback routing map, so only colocated or
  private Traefik may reach it. `/v1/storage` uses a separate storage bearer
  token and must never be exposed through ingress.
- The registry lives in a bucket and uses conditional writes to prevent lost
  updates. Coordinator leases and fences guard stale placement decisions and
  other explicitly lease-gated coordinator duties.
- The node API, runtime listeners, and operator-managed ingress are separate
  surfaces. Runtime listeners default to loopback; widening them requires the
  operator to classify the network as a private network or WireGuard transport.
- Registry and bucket state are durable; the daemon coordinates deployment and
  runtime processes. This is a trusted-workload boundary, not a secret or
  OS-isolation boundary.

## Known limitations

- Builds and runtime processes are not OS-sandboxed from the daemon or from one
  another.
- Ordinary Worker egress is direct. It can reach destinations visible from its
  network namespace, including local and internal services.
- Celld's internal operator API is mostly unauthenticated. Its safety depends
  on a private network or overlay; do not expose it publicly. See Celld's
  [security guidance](https://github.com/denoland/celld/blob/main/docs/security.md).
- Celld and fleet bucket credentials are administrative authority. Celld child
  processes receive fleet credentials, and Scafo provides no separate OS
  credential boundary against child compromise or native escape. Do not treat
  those credentials as isolated from trusted workload code. Celld documents the
  bucket as its fleet authority in its
  [security guidance](https://github.com/denoland/celld/blob/main/docs/security.md).
- Deploy intake, archive expansion, build, log, and concurrency resource
  safeguards are incomplete. Apply external host or container limits.
- Manual `scafo sail` is development-only for abrupt-death containment. Normal
  shutdown tears down supervised runtime process groups; it does not currently
  cancel an in-flight Celld deploy builder. An uncatchable bare-host daemon death
  can orphan Celld or esbuild descendants that hold fleet credentials. Production
  bare hosts must use the installer's systemd unit or an equivalent cgroup-owning
  supervisor: it must TERM the daemon first, hard-kill remaining members of its
  one non-delegated cgroup, including builders, on daemon exit or timeout, and
  allow the node's 35-second drain window.
- The image relies on its direct Node entrypoint as container process 1 in a
  private PID namespace; do not use a host PID namespace or a persistent wrapper.
  The Kubernetes manifest makes the same boundary explicit with `hostPID: false`
  and `shareProcessNamespace: false`. Physical-host failure remains outside
  process-code guarantees.
- Application authentication, public TLS, and ingress policy remain operator
  responsibilities. Celld likewise requires an operator to protect its public
  application surface and terminate TLS where needed; see its
  [security guidance](https://github.com/denoland/celld/blob/main/docs/security.md).

## Deploy safely

- Keep node-to-node, runtime-peer, and operator traffic on a private network or
  encrypted overlay. Expose only the ingress endpoints intended for application
  traffic.
- Give each installation one narrowly scoped bucket and protect bucket, node,
  storage-token, and deployment credentials as administrative secrets.
- Use external host, VM, or container resource controls for CPU, memory,
  process, filesystem, network, and cleanup limits.
- Use separate installations, buckets, and host or VM boundaries for different
  trust domains.
- Pin and review the Scafo build you deploy, and use a current supported Celld
  release. Re-read Celld's
  [security](https://github.com/denoland/celld/blob/main/docs/security.md),
  [limitations](https://github.com/denoland/celld/blob/main/docs/limitations.md),
  and [Cloudflare compatibility](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md)
  notes before upgrading.

## Celld boundary

Celld is an alpha and supports one application deployment per fleet. Security
fixes apply only to Celld's latest release; older alpha releases receive none.
Its
[limitations](https://github.com/denoland/celld/blob/main/docs/limitations.md)
define that boundary. Scafo composes projects and environments above Celld, but
does not provide stronger isolation for hostile code. Review this boundary and
the upstream notes before every upgrade.

Scafo does not add a raw TCP bridge or transparent tunnel to work around missing
Celld APIs. Upstream secure internal APIs or typed outbound HTTP/WS mediation
could be considered for a first-party implementation only after explicit
security review.

## Deferred isolation work

Hostile workload isolation is not available. Do not infer it from authorization
scopes, deployment separation, or ingress routing.
