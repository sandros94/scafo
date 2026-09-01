<!-- Keep this file aligned with the code. Describe implemented behavior only. -->

# scafo - Agent Guide

`scafo` is a self-hosted, multi-project serverless deployment platform for JS apps. Its registry is JSON in an S3-compatible bucket, mutated through CAS conditional writes. There is no database or consensus protocol. One binary is both the node daemon and CLI.

## Ask first

Ask before acting when intent is ambiguous. For design or product decisions, run a short structured Q&A: numbered questions, 2–4 concrete labeled options, your recommendation marked, then a decision synthesis before implementation.

## Vocabulary and boundaries

- A **Scafo fleet** is one installation: one registry and the Scafo nodes joined to it.
- A **Scafo node** is a machine running `scafo sail`.
- Each deployed environment has its own **Celld fleet**. A Scafo node may supervise one Celld node process for each environment assigned to it.
- Unqualified `fleet` and `node` in this repository mean Scafo's machine-level concepts. Keep Celld's process-level terms explicit when both are discussed.
- Scafo requires Celld 0.4.0. Celld owns deployment adoption, application health, cells, and runtime resource policy. Scafo owns registry, auth, placement, supervision, deploy intake, ingress convergence, and TLS storage.
- Celld exposes one current deployment per environment fleet. Scafo records a monotonic deployment revision, not a selected version. It provides no old build host or local version selection. Track the upstream lifecycle discussion in https://github.com/denoland/celld/issues/181.
- `/.well-known/scafo/health` is served by the node/API listener. `/.well-known/celld/health` is served on deployed application hosts.

## Commands

- Build: `pnpm build`
- Compile: `pnpm compile [linux-amd64|linux-arm64]`
- Test: `pnpm test`
- One test: `pnpm vitest run test/utils.test.ts`
- Type check: `pnpm typecheck`
- Lint: `pnpm lint`
- Format: `pnpm fmt`
- Benchmarks: `pnpm bench`
- Playground: `pnpm dev`
- CLI after build: `node dist/cli/index.mjs sail --help`

The ordinary integration suite starts an S3 store with testcontainers. Set `SCAFO_TEST_STORE=seaweedfs|rustfs`, or provide `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_BUCKET` for an external store.

Docker end-to-end suites are opt-in:

- `SCAFO_E2E=1 pnpm vitest run test/integration/e2e.test.ts` — one node, SeaweedFS, Caddy, Celld, two current-deployment updates, OIDC deploy auth, and retirement.
- `SCAFO_E2E=1 pnpm vitest run test/integration/e2e-traefik.test.ts` — the same application path through Traefik's pull-provider integration.
- `SCAFO_E2E=1 pnpm vitest run test/integration/e2e-multinode.test.ts` — two nodes, coordinator failover, replicas, selectors, Celld cross-node durable cells, drain, and reassignment.
- `SCAFO_E2E=1 pnpm vitest run test/integration/e2e-image.test.ts` — builds and exercises the repository image, including its non-root user, bundled Celld and esbuild, fixed healthcheck, and graceful shutdown.
- `SCAFO_E2E=1 pnpm vitest run test/integration/e2e-tls.test.ts` — Pebble, `scafo-caddy`, `/v1/storage`, shared certificate state, locks, and auth.
- `SCAFO_K3S_E2E=1 pnpm vitest run --config vitest.no-store.config.ts test/integration/e2e-k3s.test.ts` — disposable K3s, its default Traefik edge, the real manifest, two pods, placement, drain, and recovery. Requires privileged containers.

Docker absence skips these suites; report that separately from product failure.

## Public modules

- `scafo` — error and registry types plus `utils`, `registry`, `auth`, and `placement` namespaces.
- `scafo/registry` — CAS helpers, projects, builds, environments, deployment revisions, retirement, placement records, nodes, operators, trust, domains, varsets, leases, locks, TLS state, and reaping.
- `scafo/auth` — node/operator EdDSA tokens and workload OIDC verification.
- `scafo/placement` — selectors, replicas, rendezvous assignment, ports, reconcile planning, host parsing, and route rendering.
- `scafo/daemon` — configuration, API, coordinator, reconcile loop, deploy intake, storage, and observability.
- `scafo/drivers/store/{uns3,memory}` — production and test `CasStore`s.
- `scafo/drivers/runtime/celld` — one environment-owned Celld 0.4 process.
- `scafo/drivers/deploy/celld` — archive preparation and `celld deploy`.
- `scafo/drivers/supervisor/child` — child-process supervision.
- `scafo/drivers/ingress/{caddy,traefik}` — push and pull ingress drivers.
- `scafo/drivers/archive/tar-zst` — artifact packing and unpacking.
- `scafo/drivers/observe/access-log` — Caddy/Traefik access-log tailing.

## Source map

```text
src/
  index.ts
  core/
    error.ts
    types/                 # store, registry, runtime, supervisor, ingress,
                           # deploy and transport contracts
    utils/                 # validation, encoding, hashing, retry, budgets,
                           # concurrency, byte tails and access-log parsing
    auth/                  # tokens, OIDC, bounded caches and replay defense
    registry/              # all CAS-backed state and key construction
      _deployment.ts       # monotonic deployment revision after Celld publishes
      reaper.ts            # retired environment and build retention cleanup
      counting.ts          # per-operation registry accounting for observations
    placement/             # pure assignment, reconcile and route planning
  daemon/
    app.ts                 # HTTP routes and daemon context
    config.ts              # file, environment and flag configuration
    coordinator.ts         # fenced lease, assignment and reaping
    reconcile.ts           # local desired/actual loop
    deploys.ts             # artifact intake and Celld publication
    _deploy-scheduler.ts   # bounded fair queues, staged bytes and deadlines
    _assign.ts             # selectors, rendezvous and replicas across projects
    _desired.ts            # placement records into local desired state
    _execute.ts            # start, restart and stop execution
    _ingress.ts            # route rendering and ingress convergence
    _peer.ts               # authenticated node-to-node API calls
    _environments.ts       # environment operations and coordinator forwarding
    _project-routes.ts     # project API routes
    _operator-routes.ts    # operator API routes
    _storage-routes.ts     # TLS object and lock API routes
    observe*.ts            # event records, Parquet codec and bucket flushing
    access-counters.ts     # ingress traffic counters
    storage.ts             # local TLS storage service
  cli/
    index.ts
    commands/              # sail, remote, operator, fleet, project, deploy,
                           # env, varset, trust, metrics, traces and wg
    _bootstrap.ts          # daemon assembly and shutdown order
    _*.ts                  # command-specific internal operations
  drivers/
    store/                 # uns3 and memory
    runtime/               # Celld process specification
    deploy/                # Celld publication and esbuild resolution
    supervisor/            # child-process lifecycle
    ingress/               # Caddy and Traefik
    archive/               # tar.zst
    artifact/              # file-backed request staging
    observe/               # access-log tailing
```

## Architecture rules

- All registry mutation uses `CasStore` preconditions. CAS conflicts surface as `ScafoError("cas-conflict")`; retrying callers re-read before writing.
- `src/core/**` is runtime-agnostic and pure where possible. It uses Web APIs; `unjwt` under `core/auth` is the deliberate third-party exception.
- Runtime-specific work belongs behind core interfaces in `src/drivers/**`. `src/daemon/**` and `src/cli/**` assemble those drivers. New external runtime dependencies also belong in `build.config.ts`.
- Bad, expired, forged, replayed, or unknown-key tokens all become `ScafoError("auth-invalid")`. `trust-mismatch` is the distinct authorization refusal.
- Operators and nodes have separate registry keyspaces. Both write paths reject an id already held by the other identity kind.
- Admin and operator roles are distinct. Operator-tier keys are project-scoped; missing scope means no projects, while `*` explicitly means all projects.
- Bucket credentials are fleet-root authority. Operator scopes do not constrain direct bucket access.
- Node placement is selectors, then rendezvous hashing, then replica count. Scafo does not infer host memory or CPU availability and does not reserve runtime resources; operators apply resource policy through Celld and their host/container platform. Upstream Celld settings pass through `runtime.celldEnv`, `--celld-env`, or `SCAFO_CELLD_ENV`; Scafo adds no policy defaults.
- Deploy intake is still bounded: archive size and entries, output tail, active and queued tasks, staged bytes, and receive/queue/task deadlines. These are workload scheduling bounds, not runtime resource admission.
- A deployed environment has one supervised process per assigned Scafo node. The process remains environment-owned while Celld adopts new deployments. Varset changes restart it; retirement or reassignment stops it.
- Ingress contains only routes backed by local running processes plus the optional platform API apex. There is no wildcard application fallback.
- Caddy is pushed through its admin API. Traefik polls `/v1/ingress/traefik`. Both preserve operator-owned configuration.
- The public API apex must deny `/v1/storage` and `/v1/ingress/traefik` at the ingress. The storage surface uses its own bearer token.
- The node/API health endpoint is `/.well-known/scafo/health`. Application health is Celld's `/.well-known/celld/health` on application hosts.
- Observability is opt-in. Events and access-log counters are flushed as ZSTD Parquet records. `scafo metrics` and `scafo traces` read them from the bucket.
- The node listener and Celld peer listeners default to loopback. Widening them requires an explicit private-network or WireGuard transport decision.

## Packaging

- The image runs as uid 10001 with Celld 0.4.0 and esbuild. Its direct Node entrypoint must remain process 1 in a private PID namespace.
- Give the node at least 50 seconds to stop. Celld 0.4's default shutdown may take 40 seconds; Docker and Kubernetes examples must not shorten the enclosing grace below 50 seconds. A larger `CELLD_SHUTDOWN_TOTAL_MS` requires an enclosing grace at least 10 seconds larger than that value.
- Caddy/Traefik shares the node's network namespace so it can reach loopback application processes. Multi-node Celld peer traffic needs a wider runtime bind on a trusted network.
- `scripts/install.sh` verifies all downloaded executables before installing any. `scripts/uninstall.sh` preserves `/var/lib/scafo` unless `--purge` is explicit. Neither script mutates the bucket.
- `examples/` is production-shaped; `playgrounds/` is disposable. Keep both executable and self-contained.

## Code conventions

- ESM, modern TypeScript, explicit `.ts` relative imports.
- `isolatedDeclarations` is enabled; every exported symbol needs an explicit annotation.
- Prefer Web APIs in core. Put runtime APIs in drivers.
- Subject first, then an options object for multi-argument functions.
- Errors are typed contracts with actionable details and original causes.
- Reuse the existing mechanism; two implementations of one concept are a bug.
- Internal files use a leading `_`. Keep modules focused.
- Comments state constraints the code cannot show. User-facing docs describe the current implementation, not development history.

Project specs and the decision log live outside this repository.
