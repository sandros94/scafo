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
- **End-to-end, two nodes:** `SCALO_E2E=1 pnpm vitest run test/integration/e2e-multinode.test.ts` (same images, same flag). One bucket, two Caddy+agent pairs on the docker bridge: both serve the same environment, a durable object stays single-owner across them, exactly one node holds the coordinator lease, an ephemeral environment is deleted through the node that is _not_ the coordinator, and killing the coordinator's container hands the lease to the survivor. Needs `SCALO_BIND_HOST` past loopback — see the runtime-listener rule below
- **End-to-end:** `SCALO_E2E=1 pnpm vitest run test/integration/e2e.test.ts` (skipped without the flag, so `pnpm test` stays fast). Drives the whole single-node loop against real infrastructure — SeaweedFS, a Caddy the agent converges through its admin API, celld running the builds, and the built CLI — through `scalo keygen --register`, two `scalo deploy --flip` runs and a rollback, asserting what each build serves through Caddy at every step. It then plays the CI-shaped path against a stub OIDC issuer container (`test/integration/_stub-issuer.ts`): `scalo trust set`, then a `scalo deploy --token` into a new environment with NO operator key and NO bucket credential on the calling side, and a token from an untrusted subject that must fail with `trust-mismatch`. Needs docker, the images `chrislusf/seaweedfs:4.42`, `caddy:2` and `node:24-slim`, and a local `scalo-v13-probe` image carrying node 24, celld and esbuild
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
- `scalo` (bin) — the CLI; `scalo up` boots a node agent, `scalo keygen` mints an operator key, `scalo deploy` uploads a build, `scalo varset` seals an environment's variables, `scalo trust` says which CI issuers may deploy a project, `scalo wg` sets this node up on the WireGuard tunnel

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
      transport.ts        # transport seam: TransportMode, TransportConfig
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
      reaper.ts           # plan/execute lease-gated GC, and operator-ordered deletion
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
    coordinator.ts        # createCoordinator: the lease loop, its fence, the lease-gated reap
    deploys.ts            # createDeployService: accept an artifact, publish it, watch it land
    _execute.ts           # internal: carries out one plan (activate/start/gate/stop)
    _desired.ts           # internal: desired state read out of the registry
    _ingress.ts           # internal: renders the routing after a pass and applies it
    _environments.ts      # internal: environment deletion, and the hop to the coordinator
    _intake.ts            # internal: dual-token auth, multipart and JSON request reading
    index.ts              # barrel
  cli/
    index.ts              # the `scalo` binary (citty)
    commands/
      up.ts               # `scalo up`: register the node and serve the agent
      keygen.ts           # `scalo keygen`: mint (and register) an operator key
      deploy.ts           # `scalo deploy`: pack a directory, upload it, follow the deploy
      varset.ts           # `scalo varset`: seal a variable file, list what an environment carries
      trust.ts            # `scalo trust`: which CI issuers may deploy a project
      wg.ts               # `scalo wg`: set this node up on the tunnel, refresh its peers
    _bootstrap.ts         # internal: the steps between reading the config and serving
    _node-state.ts        # internal: the identity a node keeps across restarts
    _trust.ts             # internal: editing a project's trust policy, and printing it
    _varset.ts            # internal: dotenv parsing, sealing, describing without leaking
    _varset-key.ts        # internal: the varset key file and the three forms it comes in
    _wireguard.ts         # internal: the tunnel settings, and sourcing the WG keypair
    _wg-conf.ts           # internal: rendering wg0.conf from the registry's peer list
    _utils.ts             # internal: file reads, secret writes, state dir, failure output
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
- **A deploy is accepted, then carried out.** `POST /v1/deploys` takes multipart `meta` + `artifact`, ensures the project and environment exist — reading the environment before creating one, because a deploy asks only that it _exist_ and must not be refused for disagreeing with settings it never named, such as the `ephemeral` of a preview environment — answers `202` with a `Location`, and does the rest in the background: publish the artifact through `DeployRunner` (unpack, run the builder, read back the runtime's version id), record an immutable build, and — when the upload asked to flip — move the alias and watch the reconcile loop until a process serving that build is ready. Exactly three states are final (`deployed`, `routed`, `failed`), so a client polls until it reaches one. Missing the routing deadline is a warning and never an error: the build exists and the loop keeps trying. Deploy status is soft state held in memory, so a restarted agent forgets deploys in flight while the registry remembers everything they had already committed.
- **A node is its keypair, and it keeps it.** The id a node registers under and the Ed25519 pair that speaks for it live together in `<stateDir>/node.json`, written `0600` in a directory created `0700`, and are generated only on the first boot. The record in the registry is rewritten on every boot because it is derived state, but the identity behind it is not: a node that regenerated its key would leave a stale public key in the registry and have every token it signs rejected for reasons nothing on it explains. A state file that cannot be read as an identity therefore refuses the boot rather than being replaced — deleting it is a deliberate act — and the configuration only ever _pins_ an id, which replaces the identity outright when it changes.
- **An unclassified network is refused, not assumed.** Every address a node exposes carries traffic that commands it. As soon as the agent listener, the internal listener, the advertised address or `runtime.bindHost` reaches past loopback, `scalo up` refuses to boot until `transport.driver` says which network that is: `wireguard` to tunnel it, `none` to state that it is already private and trusted. There is no default, because the safe-looking one silently exposes a node and the other refuses working setups. A loopback-only node crosses nothing and needs neither.
- **Runtime listeners bind loopback until a fleet needs otherwise.** A runtime process listens on `runtime.bindHost` (default `127.0.0.1`), which is everything a single node needs: its own ingress and its own readiness probe are on that host. A fleet spread over several nodes is the case that needs more — one cell has one owner, and a request that lands on a node that does not own it is forwarded to the one that does, dialling the address that node advertises. Nothing answers there while the listeners are on loopback, so cross-node cell traffic simply cannot work; that is what `runtime.bindHost` widens. It is not a tuning knob: the runtime's peer listener authenticates nobody, so widening it exposes an unauthenticated surface and is therefore gated on the same transport decision as every other exposed address.
- **A coordinator that loses its renewal stops being one, immediately.** The lease in the bucket is the whole election — there is no consensus protocol. `createCoordinator` renews every `ttlMs/3`, and a renewal that does not land drops the node to candidate _before_ any coordinator-only work runs on that tick, whether the lease was taken away or the bucket merely could not be reached. The two are indistinguishable from the node's side and the safe reading of both is the same, because the node that superseded it is already acting. Deletes cannot be conditional, so the lease is the only thing keeping two reapers apart; a reap that fails for any other reason is recorded, the lease is kept, and the next tick plans again from fresh state.
- **Lease-gated work is forwarded, not refused.** Only the coordinator can carry out a deletion, but which node that is at any moment is the installation's business rather than the operator's. Any node accepts `DELETE /v1/environments/:project/:env`: it does the work when it holds the lease, offers itself once when nobody holds one, and otherwise forwards the request to the holder and returns that answer verbatim. The hop carries a FRESH node token this node signed for itself — never the caller's, which is single-use and was already spent verifying it here — and an `x-scalo-proxied: 1` header, so a forward that lands on a node that does not coordinate either is answered `503` instead of being forwarded again.
- **An environment is served with its variables or not at all.** A node opens its environments' varsets with one AES-256 key, read from a file the operator configures. An environment whose varset this node cannot open — no key, the wrong key, an altered envelope — is recorded as a failure of that one environment and keeps whatever process it already had; the pass carries on and every other environment is served. Starting it unconfigured would come up, pass its readiness gate and serve requests against whatever the code falls back to, which is a misconfiguration nothing reports.
- **Key material is the operator's, never scalo's.** A WireGuard identity is an X25519 keypair, and there is no scalar multiplication on the web-crypto surface every runtime shares. So scalo computes none: `scalo wg init` reads `<stateDir>/wg-private.key` if it is there, shells out to `wg genkey` if it is not, and refuses with the exact command to run if there is neither — the public half likewise, from a file beside it or from `wg pubkey`. Both halves are then persisted `0600`, so a node that has been set up boots on a host that never had wireguard-tools. Bringing the interface up is the operator's step too, because it needs a kernel module and NET_ADMIN: scalo renders `wg0.conf` from the registry's own peer list — every node publishes its key, endpoint and address in its record — prints `wg-quick up`, and stops. A peer's `AllowedIPs` is its own address alone (`/32`, `/128`), never the subnet its record names, because a peer allowed the whole subnet claims every other node's route. Assisted, never magical: an amateur curve implementation inside an operator's private network is a worse outcome than an error message.
- **A tunnelled node lives at its tunnel address.** When `transport.driver` is `wireguard`, `runtime.bindHost` and the advertised address both default to the node's own WireGuard address rather than to loopback or to whatever wildcard the listener bound — inside a tunnel those are the only addresses a peer can actually dial. Explicit configuration still wins. The tunnel's own settings are required in that mode and refused for by name; configured on a node running another transport they are reported as ignored rather than quietly kept.
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
