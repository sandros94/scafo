<!-- NOTE: Keep this file updated as the project evolves. When making architectural changes, adding new patterns, or discovering important conventions, update the relevant sections. -->

# scalo - Agent Guide

`scalo` is a self-hosted, multi-project serverless deployment platform for JS apps. Its state is a registry of JSON objects living in an S3-compatible bucket, mutated only through CAS conditional writes (`If-Match` / `If-None-Match`) — there is no database and no consensus protocol. A single binary is both the node agent and the CLI.

## Core Principle — Ask First

**When in doubt, ask before acting.** It is always more important to understand the vision and the request than to assume. There is no shame or wasted time in asking clarifying questions — this applies to every conversation and every task in this project.

### Q&A Sessions

When a task involves design decisions, ambiguity, or changes to the project vision, run a structured Q&A session before implementing. Format each question with **2–4 concrete options** the user can pick from, mix, or override with a custom answer. This keeps sessions concise and efficient:

- **Number questions** (Q1, Q2, …) so answers can reference them quickly.
- **Each option** should be a short, self-contained description (1–2 sentences) with a label (A, B, C, D).
- **Avoid open-ended questions** — always propose options. If genuinely unsure, provide your best guesses as options.
- **Group related questions** in a single message rather than asking one at a time.
- After answers, **synthesize** the decisions into a summary and confirm before implementing.
- If the answers reveal further ambiguity, do another focused round — don't assume.

## Commands

- **Build:** `pnpm build` (uses obuild/rolldown)
- **Test:** `pnpm test` (vitest; the integration suite auto-starts an S3 store container via testcontainers — needs docker. `SCALO_TEST_STORE=seaweedfs|rustfs` picks the store, default seaweedfs; set `S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_BUCKET` to target an external store instead)
- **Single test file:** `pnpm vitest run test/utils.test.ts`
- **End-to-end:** `SCALO_E2E=1 pnpm vitest run test/integration/e2e.test.ts` (skipped without the flag, so `pnpm test` stays fast). Drives the whole single-node loop against real infrastructure — SeaweedFS, a Caddy the agent converges through its admin API, celld running the builds, and the built CLI — through `scalo keygen --register`, two `scalo deploy --flip` runs and a rollback, asserting what each build serves through Caddy at every step. Needs docker, the images `chrislusf/seaweedfs:4.42` and `caddy:2`, and a local `scalo-v13-probe` image carrying node 24, celld and esbuild
- **Type check:** `pnpm typecheck` (uses `tsc` from TypeScript 7)
- **Lint:** `pnpm lint` (oxlint + oxfmt --check)
- **Format:** `pnpm fmt` (automd + oxlint --fix + oxfmt)
- **Benchmarks:** `pnpm bench`
- **Dev playground:** `pnpm dev` (runs `playground/main.ts` with bun)
- **CLI:** `node dist/cli/index.mjs up --help` after a build (installed as the `scalo` binary)

## Architecture

### Module structure (each is a separate export path)

- `scalo` — barrel: `ScaloError` and friends, the registry types, plus the `utils`, `registry`, `auth`, `capacity` and `placement` namespaces
- `scalo/registry` — registry operations: keys, CAS document helpers, coordinator lease, projects, builds, environments, varsets, nodes, trust, domains, reaper
- `scalo/auth` — node/operator EdDSA tokens and workload OIDC verification
- `scalo/capacity` — cgroup v2 parsing and the capacity planning formulas
- `scalo/placement` — the pure reconcile planner, the pure route renderer, the process-id convention and the port allocator
- `scalo/agent` — the node agent: configuration loading, the HTTP API and its listener, the reconcile loop, deploy intake
- `scalo/drivers/store/uns3` — `CasStore` backed by an S3-compatible bucket via [`uns3`](https://github.com/sandros94/uns3)
- `scalo/drivers/store/memory` — in-process `CasStore` with identical CAS semantics, for tests and local development
- `scalo/drivers/host/node` — `HostReader` probing cgroup v2 and host totals on Node-compatible runtimes
- `scalo/drivers/runtime/celld` — `RuntimeDriver` for celld 0.2.x: process spec, deployment-pointer activation, readiness gate
- `scalo/drivers/supervisor/child` — `Supervisor` running supervised processes as children of the agent
- `scalo/drivers/ingress/caddy` — `IngressDriver` converging an operator-run Caddy through its admin API
- `scalo/drivers/deploy/celld` — `DeployRunner` unpacking an artifact and publishing it with the celld CLI
- `scalo/drivers/archive/tar-zst` — the `.tar.zst` artifact format, packed by the client and unpacked by the agent
- `scalo` (bin) — the CLI; `scalo up` boots a node agent, `scalo keygen` mints an operator key, `scalo deploy` uploads a build

### Source layout

```
src/
  index.ts                # barrel: error + types, utils/registry namespaces
  core/
    error.ts              # ScaloError, ScaloErrorCode, RFC 9457 toProblem()
    types/
      store.ts            # CasStore, CasHeaders, StoredObject
      registry.ts         # registry record shapes + the bucket key each lives at
      supervisor.ts       # Supervisor seam: ProcessSpec, ProcessStatus
      runtime.ts          # RuntimeDriver seam: RuntimeProcess, RuntimeSpecInput, ProbeOptions
      ingress.ts          # IngressDriver seam: IngressDesired, IngressBackend
      deploy.ts           # DeployRunner seam: DeployRunInput, DeployTarget
      index.ts            # type barrel
    utils/
      slug.ts             # slug validation, host-label format/parse
      host.ts             # DNS host validation
      hash.ts             # sha256Hex
      json.ts             # stableStringify (deterministic JSON)
      base64.ts           # unpadded base64url
      backoff.ts          # withRetry (full jitter, retries CAS conflicts by default)
      index.ts
    registry/
      context.ts          # RegistryContext (store + injectable clock)
      paths.ts            # every bucket key, with input validation
      cas.ts              # JSON over CAS: read/create/update (read-modify-retry)/delete
      lease.ts            # fenced coordinator lease
      meta.ts             # store conformance probe + registry bootstrap
      projects.ts         # create/get/list/update
      builds.ts           # create/get/list — immutable, reaper-only deletion
      environments.ts     # create/get/list, alias flip + rollback, splits, varset
      varsets.ts          # AES-256-GCM seal/open, content-addressed envelopes
      nodes.ts            # node registration, lease-gated removal
      trust.ts            # OIDC deploy policy + subject matching
      domains.ts          # custom domain claims (Caddy on-demand-TLS ask)
      reaper.ts           # plan/execute lease-gated GC
      _shared.ts          # internal: error guards, deep equality, key-name parsing
      index.ts            # barrel
    auth/
      node-token.ts       # signNodeToken, createNodeVerifier (EdDSA, single-use)
      oidc.ts             # createOidcVerifier (workload deploy intake)
      _shared.ts          # internal: uniform rejection, unverified token reads
      _cache.ts           # internal: bounded insertion-ordered map
      _key-cache.ts       # internal: registry node keys, TTL = revocation bound
      _replay.ts          # internal: spent jti window
      _jwks.ts            # internal: OIDC discovery + per-issuer JWKS cache
      index.ts            # barrel
    capacity/
      cgroup.ts           # cgroup v2 memory.max / cpu.max parsing
      compute.ts          # capacity formulas: cores, memMb, rss budget, cells
      reader.ts           # HostReader seam + probeCapacity(reader)
      index.ts            # barrel
    placement/
      ids.ts              # `project--env--build` process-id convention (format/parse)
      ports.ts            # loopback port-pair allocator over a configured range
      reconcile.ts        # planReconcile: desired + actual -> ordered actions (pure)
      routes.ts           # renderRoutes: environments + ready processes -> hosts (pure)
      index.ts            # barrel
  agent/
    config.ts             # loadAgentConfig: file + env + flags, runtime-agnostic
    middleware.ts         # bearer auth guard + RFC 9457 error rendering
    app.ts                # createAgentApp: AgentContext and the HTTP routes
    serve.ts              # startAgent: binds the app to config.node.listen
    reconcile.ts          # createReconciler: the loop, its status, one pass at a time
    deploys.ts            # createDeployService: accept an artifact, publish it, watch it land
    _execute.ts           # internal: carries out one plan (activate/start/gate/stop)
    _desired.ts           # internal: desired state read out of the registry
    _ingress.ts           # internal: renders the routing after a pass and applies it
    _intake.ts            # internal: dual-token auth, multipart and JSON request reading
    index.ts              # barrel
  cli/
    index.ts              # the `scalo` binary (citty)
    commands/
      up.ts               # `scalo up`: register the node and serve the agent
      keygen.ts           # `scalo keygen`: mint (and register) an operator key
      deploy.ts           # `scalo deploy`: pack a directory, upload it, follow the deploy
    _utils.ts             # internal: file reads, package version, failure output
  drivers/
    store/
      uns3.ts             # createUns3Store()
      memory.ts           # MemoryCasStore, createMemoryStore()
    host/
      node.ts             # createNodeHostReader() — node:fs/promises + node:os
    runtime/
      celld.ts            # createCelldDriver() — process spec, activation, readiness gate
      _deploy-pointer.ts  # internal: celld's deploy/current.json, read-modify-write
    supervisor/
      child.ts            # createChildSupervisor() — node:child_process
    ingress/
      caddy.ts            # createCaddyDriver() — converges routes over Caddy's admin API
    deploy/
      celld.ts            # createCelldDeployRunner() — unpack, publish, read back the version
      _esbuild.ts         # internal: locating esbuild's per-platform binary
    archive/
      tar-zst.ts          # packDirectory/unpackArchive — the artifact format, node:zlib + tar
```

### Key design patterns

- **CAS-only mutation:** every registry write goes through `CasStore.put()` with a precondition. A failed precondition surfaces as `ScaloError("cas-conflict")`; callers recover by re-reading and retrying (`utils.withRetry`).
- **`src/core/**` has zero foreign runtime dependencies.** It may not import third-party packages — only web-standard globals (`crypto.subtle`, `TextEncoder`, `fetch`). The one exception is [`unjwt`](https://github.com/sandros94/unjwt) inside `src/core/auth/**`: own runtime-agnostic libraries are building blocks, not dependencies to avoid.
- **Layers decide what may be imported.** `src/core/**` is pure as above. `src/drivers/**` is where a runtime is allowed: `node:*`, `uns3`. `src/agent/**` and `src/cli/**` are the application layer and may use established runtime-agnostic packages (`h3`, `confbox`, `citty`); of the two, only the CLI reaches for `node:*` — `src/agent/config.ts` in particular takes its file reader as an argument so it stays runnable anywhere. Every new runtime dependency also belongs in `external` in `build.config.ts`.
- **Core never reaches for a runtime.** Anything impure lives behind an interface core defines and a driver implements (`CasStore`, `HostReader`); the caller wires the two together.
- **One rejection for every bad token:** `src/core/auth` answers expired, replayed, unknown-key, forged and malformed tokens with the same `ScaloError("auth-invalid")` — no message, no detail, reason in `cause`. Only a trust-policy denial is distinguishable (`trust-mismatch`), because that is authorization, not authentication.
- **Single error type:** `ScaloError` carries a stable `code` plus an HTTP `status`, and renders to an RFC 9457 problem document. Messages may change, codes may not.
- **Single multi-input bundle:** all entry points are `input`s of one `type: "bundle"` in `build.config.ts`, so rolldown code-splits shared core into `dist/_chunks/*`. Adding an entry = add its input (and any runtime dep to `external`).
- **Store drivers are interchangeable:** `MemoryCasStore` implements the same conditional-write contract as the S3 driver, so registry logic can be tested without a bucket.
- **Readiness is two questions, not one.** A runtime's own health endpoint reports on the _process_, not on the application it hosts: a process whose worker fails every single request still answers it with 200, and a process that is draining answers it while refusing everything else. `RuntimeDriver.probeReady` therefore gates on both the runtime health endpoint **and** an application-level request to a configured path, and only calls a process ready when both agree. A process is never sent traffic, and never allowed to replace the one it supersedes, until it has passed both.
- **Idle eviction stays off, permanently.** In celld 0.2.1, evicting a cell because it has been idle corrupts that cell's replication chain in the bucket — writes already acknowledged to the client roll back the next time the cell is restored. The runtime disables idle eviction when its variable is simply absent, so the celld driver never sets `CELLD_IDLE_EVICT_S`, refuses (`ScaloError("invalid-input")`) any caller that passes it in `extraEnv`, and strips it from the environment a process would otherwise inherit. This is a data-safety rule, not a tuning preference: it stays until the upstream fix lands and is verified.
- **Routing follows readiness, never intent.** `renderRoutes` is pure and takes only what a node actually has running: an environment is reachable at `<project>--<env>.<domain>` (plus `<project>.<domain>` for `production`, plus any custom domain claimed for it) solely when a process serving its alias build has passed its readiness gate, and every ready process is separately reachable at `<project>--<build>.<domain>` so a build stays inspectable for as long as it runs. Hosts whose label would exceed the DNS limit are skipped rather than thrown over — one unnameable environment must not take a node's whole routing with it. The reconcile loop renders this after every pass and hands it to `IngressDriver.apply`, whose failures are recorded in the pass status and never abort it: an ingress that cannot be reached must not stop a node reconciling itself.
- **A deploy is accepted, then carried out.** `POST /v1/deploys` takes multipart `meta` + `artifact`, ensures the project and environment exist, answers `202` with a `Location`, and does the rest in the background: publish the artifact through `DeployRunner` (unpack, run the builder, read back the runtime's version id), record an immutable build, and — when the upload asked to flip — move the alias and watch the reconcile loop until a process serving that build is ready. Exactly three states are final (`deployed`, `routed`, `failed`), so a client polls until it reaches one. Missing the routing deadline is a warning and never an error: the build exists and the loop keeps trying. Deploy status is soft state held in memory, so a restarted agent forgets deploys in flight while the registry remembers everything they had already committed.
- **Two ways in, one way out.** The deploy-facing routes accept either an operator's node token or a project's workload OIDC token. The node token is tried first because it needs nothing but the header; only when it fails as authentication is the bearer offered to the trust policy of the project the request names. A caller that fails both gets the single `auth-invalid` problem document every other rejection uses — it cannot learn which half it failed, nor whether the project exists. The one distinguishable outcome is `trust-mismatch`, which is authorization: a token trusted for one project can never deploy or flip another.

## Code Conventions

- Use **ESM** and modern JavaScript, with a type-first approach.
- Before adding new code, study surrounding patterns, naming conventions, and architectural decisions.
- `isolatedDeclarations` is on: every exported symbol needs an explicit type annotation.
- Relative imports carry the explicit `.ts` extension.
- Prefer **Web APIs** over Node.js APIs where possible.
- Keep runtime code minimal and fast.
- Place non-exported/internal helpers at the end of the file.
- Comments are usage-facing only — what a caller must know, constraints, caveats. No development history or decision narrative. `TODO` comments are fine for known gaps.
- Split logic across files; avoid long single-file modules (>200 LoC). Use `_*` prefix for internal files.
- For multi-arg functions, use an options object as the second parameter.

Project specs and the decision log are maintained outside this repository.
