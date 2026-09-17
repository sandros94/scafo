<!-- Keep this file aligned with the code. Describe implemented behavior only. -->

# scafo - Agent Guide

`scafo` is a self-hosted, multi-project serverless deployment platform for JS apps. Its JSON registry lives in an S3-compatible bucket and is mutated with CAS conditional writes; it has no database or consensus protocol. One binary is both node daemon and CLI.

## Ask first

Ask before acting when intent is ambiguous. For design or product decisions, run a short structured Q&A: numbered questions, 2–4 concrete labeled options, a marked recommendation, then synthesize and confirm decisions before implementation.

## Boundaries

- A Scafo fleet is one installation: one registry and its Scafo nodes. A Scafo node is a machine running `scafo sail`.
- Each deployed environment has its own Celld fleet. A Scafo node may supervise one Celld node process per assigned environment. Unqualified `fleet` and `node` mean Scafo's machine-level concepts; name Celld's process-level concepts explicitly.
- Scafo requires Celld 0.5.0: `scafo sail` runs `celld --version` before it opens the bucket and refuses an older or unreadable binary with `capability-missing`, and each node record carries the `versions` (Scafo and Celld) its daemon booted with. A node does not start an environment's process, and does not accept a deploy for it, while another live node serving that environment reports a different Celld version (`version-skew`, 409); an upgrade stops every node of the installation first. Celld owns deployment adoption, application health, cells, and runtime resource policy; Scafo owns registry, auth, placement, supervision, deploy intake, and the routing every ingress reads.
- Celld exposes one current deployment per environment fleet. Scafo records a monotonic deployment revision, not a selected version; it has no per-deployment host or local version selection. See https://github.com/denoland/celld/issues/181.
- Vocabulary follows Celld: a **deployment** is what Celld serves, identified by its **version**; a **deploy** is one run of `scafo deploy`; a **build** is compiling only (esbuild, the image, `pnpm build`).
- `/.well-known/scafo/health` is served by the node/API listener; `/.well-known/celld/health` is served on application hosts. `scafo health` probes the former at the listener it resolves from the daemon's own sources (env and config file, not `sail` flags); it is the image's HEALTHCHECK.

## Commands

- `pnpm build`, `pnpm compile [linux-amd64|linux-arm64]`, `pnpm test`
- `pnpm vitest run test/utils.test.ts`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt`
- `node dist/cli/index.mjs sail --help`

The ordinary integration suite starts an S3 store with testcontainers. Set `SCAFO_TEST_STORE=seaweedfs|rustfs`, or supply `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_BUCKET`.

Docker E2E is opt-in; absent Docker skips a suite, not a product failure. Run `pnpm build` first (the suites run `dist/cli/index.mjs`) and `docker build --target probe -t scafo-probe .` once (the node host the suites bind-mount the build into). Use `vitest.no-store.config.ts`; these suites own their containers.

- `SCAFO_E2E=1 pnpm vitest run --config vitest.no-store.config.ts test/integration/e2e.test.ts` — Caddy, deploy adoption, OIDC, retirement.
- `SCAFO_E2E=1 pnpm vitest run --config vitest.no-store.config.ts test/integration/e2e-traefik.test.ts` — Traefik pull provider.
- `SCAFO_E2E=1 pnpm vitest run --config vitest.no-store.config.ts test/integration/e2e-multinode.test.ts` — replicas, selectors, durable cells, failover, drain, reassignment.
- `SCAFO_E2E=1 pnpm vitest run --config vitest.no-store.config.ts test/integration/e2e-image.test.ts` — non-root image, bundled tools, healthcheck, shutdown.
- `SCAFO_E2E=1 pnpm vitest run --config vitest.no-store.config.ts test/integration/e2e-tls.test.ts` — TLS storage, locks, and auth.
- `SCAFO_K3S_E2E=1 pnpm vitest run --config vitest.no-store.config.ts test/integration/e2e-k3s.test.ts` — real manifest, default Traefik, placement, drain, two-pod recovery; requires privileged containers.
- `pnpm vitest run test/integration/store.test.ts` — bucket conformance against the `SCAFO_TEST_STORE` matrix (seaweedfs, rustfs).

## Placement of work

- `src/core/**` holds runtime-agnostic contracts, registry, auth, and pure placement logic.
- `src/drivers/**` implements runtime seams; `src/daemon/**` and `src/cli/**` assemble them.
- Internal files use a leading `_`. `examples/` is production-shaped; `playgrounds/` is disposable. Keep both executable and self-contained.

## Architecture and security

- All registry mutation uses `CasStore` preconditions. Surface conflicts as `ScafoError("cas-conflict")`; retrying callers re-read before writing. The store driver repeats a write the store answers with a transient error and raises `ScafoError("store-unavailable")`—503—once the tries run out, and a lease or lock refused by its own precondition is re-read before it is called lost.
- Keep core pure where practical and on Web APIs; `unjwt` in `core/auth` and `unsecure` where external text is parsed are the exceptions. Put runtime work behind core interfaces in drivers; add external runtime dependencies to `build.config.ts`.
- Token failures—bad, expired, forged, replayed, or unknown-key—are `ScafoError("auth-invalid")`. `trust-mismatch` remains the distinct authorization refusal.
- External text becomes an object through `unsecure` only—registry documents, request bodies, tokens, access logs, config and artifact files carry no key an object answers for on its own, and a config setting is read from a key the file itself holds. One rule refuses those names wherever variables are written: a varset and `runtime.celldEnv` alike.
- Operators and nodes use separate keyspaces and cannot share an id. Admin and operator roles differ; operator-tier keys are project-scoped: missing scope grants none, `*` grants all. Bucket credentials remain fleet-root authority.
- Placement is selectors, rendezvous hashing, then replica count. Scafo neither infers nor reserves host resources; operators set runtime policy through Celld and the host/container platform via `runtime.celldEnv`, `--celld-env`, or `SCAFO_CELLD_ENV`. Scafo adds no Celld policy defaults.
- Bound deploy intake by archive size and entries, output tail, active/queued tasks, staged bytes, and receive/queue/task deadlines. These are scheduling bounds, not runtime admission.
- A deploy id is `<project>.<16 hex>`, and every state it moves through is a registry record under that project: any node answers a poll—the project in the id is what authenticates the caller—and a restart of the accepting node loses nothing. A record that reaches `deployed` names the deployment it produced by version. The coordinator's reaper fails a non-terminal record whose node stopped answering and deletes terminal ones after 7 days.
- Run one environment-owned process per assigned Scafo node. Celld adopts deployments; retirement or reassignment stops the process. Each deployment a deploy produces is recorded immutably at `_scafo/projects/<project>/deployments/<version>.json`, under the version Celld assigned and nothing else. An environment's varset is named per project, edited in place, and carried by its next deploy — it reaches nothing that is already running. Deploy intake merges it into the artifact's `wrangler.jsonc` `vars`, refuses a name both declare, and stamps the varset's name and digest into the deployment notice.
- Publish only routes backed by running processes and the optional platform API apex—never a wildcard application fallback. Every ingress pulls: nothing is pushed into one. A node serves the fleet's routing at `/v1/ingress/routes`, generic or in a format an ingress speaks natively (`/v1/ingress/routes/traefik`); Caddy reads it through the `scafo` dynamic-upstreams module and Traefik through its http provider. Before a node's first reconcile pass has finished, both routes refuse with `ScafoError("draining")`—503—rather than serving an empty document: nothing deployed is an answer a poller acts on, and a node that has just booted does not have one. Operator configuration is the ingress's own and Scafo never rewrites it.
- Deny `/v1/storage` and `/v1/ingress/routes` at the public API apex, matched at a path-segment boundary, and the ingress must enforce that itself rather than trust the daemon behind it. Both surfaces are behind the ingress bearer token, which is the only credential an ingress holds.
- Observability is opt-in: events and access counters are ZSTD Parquet in the bucket; `scafo metrics` and `scafo traces` read them.
- `scafo deployment prune` deletes an environment's old Celld deployments (`deploy/<script>/<version>/` and the Scafo deployment record), never a version a Celld pointer names and never `deploy-blobs/`; a pointer that moves onto a selected deployment refuses it as `cas-conflict`. It keeps the newest `--keep` (default 10) and deletes only what is ALSO older than `--older-than` (default 24h) — both gates are always weighed, and `0` lifts the one it is given to. A real run prints the plan, then asks at the terminal before it deletes; `--yes` answers ahead of the question, and a run whose input is not a terminal refuses with `invalid-input` rather than take silence for consent. The command is unstable until Celld has a deployment lifecycle of its own and warns on every run. CLI warnings go to stderr as `scafo: warning: …`; `SCAFO_SILENCE_WARNINGS=1` silences all of them.
- Scafo API and Celld peer listeners default to loopback. Widen only through an explicit private-network or WireGuard decision.

## Packaging

- The image runs as uid 10001 with Celld 0.5.0 and esbuild. Its direct Node entrypoint stays PID 1 in a private PID namespace.
- Allow at least 50 seconds for node shutdown. Celld's default may take 40; Docker and Kubernetes grace periods must not be shorter. If `CELLD_SHUTDOWN_TOTAL_MS` is larger, give the enclosing grace at least 10 seconds more.
- Caddy/Traefik share the node network namespace to reach loopback application processes. Multi-node Celld peer traffic needs a trusted wider bind.
- `scripts/install.sh` verifies every download before installation. `scripts/uninstall.sh` preserves `/var/lib/scafo` unless `--purge`; neither mutates the bucket.

## Conventions

- ESM, modern TypeScript, explicit `.ts` relative imports; `isolatedDeclarations` requires annotations on exports.
- Prefer Web APIs in core. Use subject-first functions with an options object for multiple arguments. Errors are typed contracts with actionable details and original causes.
- Reuse existing mechanisms; keep modules focused. Prefer one short block comment at a hidden constraint; user docs describe current behavior, not history.

Project specs and the decision log live outside this repository.
