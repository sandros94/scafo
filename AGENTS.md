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
- **End-to-end, two nodes:** `SCALO_E2E=1 pnpm vitest run test/integration/e2e-multinode.test.ts` (same images, same flag). One bucket, two Caddy+agent pairs on the docker bridge: both serve the same environment, a durable object stays single-owner across them, exactly one node holds the coordinator lease, an ephemeral environment is deleted through the node that is _not_ the coordinator, an environment scaled to `replicas: 1` ends up on exactly one node while the other stops serving it, `docker stop` on the node holding it moves it to the survivor well inside the liveness window a crash would have to wait out (the drain path) and the node serves again when it is started back up, an environment retired through `scalo env` stops being served on both nodes and refuses deletion until `--force`, and killing the coordinator's container hands the lease to the survivor — which then either takes the single-replica environment over or keeps serving it untouched, depending on which node placement had given it to. Needs `SCALO_BIND_HOST` past loopback — see the runtime-listener rule below
- **End-to-end:** `SCALO_E2E=1 pnpm vitest run test/integration/e2e.test.ts` (skipped without the flag, so `pnpm test` stays fast). Drives the whole single-node loop against real infrastructure — SeaweedFS, a Caddy the agent converges through its admin API, celld running the builds, and the built CLI — through `scalo keygen --register`, two `scalo deploy --flip` runs and a rollback, asserting what each build serves through Caddy at every step. It then plays the CI-shaped path against a stub OIDC issuer container (`test/integration/_stub-issuer.ts`): `scalo trust set`, then a `scalo deploy --token` into a new environment with NO operator key and NO bucket credential on the calling side, and a token from an untrusted subject that must fail with `trust-mismatch`. Needs docker, the images `chrislusf/seaweedfs:4.42`, `caddy:2` and `node:24-slim`, and a local `scalo-v13-probe` image carrying node 24, celld and esbuild
- **End-to-end, through Traefik:** `SCALO_E2E=1 pnpm vitest run test/integration/e2e-traefik.test.ts` (same flag, same topology as the single-node suite with `traefik:v3` in Caddy's place, sharing the agent's network namespace). Proves the second ingress end to end and, more to the point, the PULL model: the node publishes its routing at `/v1/ingress/traefik` and Traefik's `http` provider polls it every 2s, so each assertion separates what the node published from what Traefik serves and the suite reports the delay between them. Covers the empty configuration a fresh node publishes, a routeless host (Traefik answers `404 page not found`, where Caddy answers an empty `200`), two `scalo deploy --flip` runs, and `scalo env retire` taking the last environment away — which is the case the driver is built around, because Traefik refuses a configuration whose maps are empty and would otherwise keep serving a stopped build. Shares `test/integration/_harness.ts` with nothing else yet; the topology is the part worth reading
- **Type check:** `pnpm typecheck` (uses `tsc` from TypeScript 7)
- **Lint:** `pnpm lint` (oxlint + oxfmt --check)
- **Format:** `pnpm fmt` (automd + oxlint --fix + oxfmt)
- **Benchmarks:** `pnpm bench`
- **Dev playground:** `pnpm dev` (runs `playground/main.ts` with bun)
- **CLI:** `node dist/cli/index.mjs up --help` after a build (installed as the `scalo` binary)

## Architecture

### Module structure (each is a separate export path)

- `scalo` — barrel: `ScaloError` and friends, the registry types, plus the `utils`, `registry`, `auth`, `capacity` and `placement` namespaces
- `scalo/registry` — registry operations: keys, CAS document helpers, coordinator lease, projects, builds, environments, retirement, varsets, nodes, trust, domains, reaper
- `scalo/auth` — node/operator EdDSA tokens and workload OIDC verification
- `scalo/capacity` — cgroup v2 parsing and the capacity planning formulas
- `scalo/placement` — the pure reconcile planner, the pure route renderer, the process-id convention, the port allocator, and the rendezvous hashing and replica-count rules that decide which nodes serve an environment
- `scalo/agent` — the node agent: configuration loading, the HTTP API and its listener, the reconcile loop, deploy intake
- `scalo/drivers/store/uns3` — `CasStore` backed by an S3-compatible bucket via [`uns3`](https://github.com/sandros94/uns3)
- `scalo/drivers/store/memory` — in-process `CasStore` with identical CAS semantics, for tests and local development
- `scalo/drivers/host/node` — `HostReader` probing cgroup v2 and host totals on Node-compatible runtimes
- `scalo/drivers/runtime/celld` — `RuntimeDriver` for celld 0.2.x: process spec, deployment-pointer activation, readiness gate
- `scalo/drivers/supervisor/child` — `Supervisor` running supervised processes as children of the agent
- `scalo/drivers/ingress/caddy` — `IngressDriver` converging an operator-run Caddy through its admin API
- `scalo/drivers/ingress/traefik` — `IngressDriver` rendering the same routing as a Traefik dynamic configuration, which Traefik polls off the agent
- `scalo/drivers/deploy/celld` — `DeployRunner` unpacking an artifact and publishing it with the celld CLI
- `scalo/drivers/archive/tar-zst` — the `.tar.zst` artifact format, packed by the client and unpacked by the agent
- `scalo` (bin) — the CLI; `scalo up` boots a node agent, `scalo keygen` mints an operator key, `scalo deploy` uploads a build (`--replicas <n|all>` states how many nodes serve the environment), `scalo env` retires an environment out of service and deletes it once it is really meant to go (`--force` skips the wait), `scalo varset` seals an environment's variables, `scalo trust` says which CI issuers may deploy a project, `scalo wg` sets this node up on the WireGuard tunnel

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
      ingress.ts          # IngressDriver seam: IngressDesired, IngressBackend, PullingIngressDriver
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
      retirement.ts       # retire/unretire, the grace, and what may be deleted
      placement.ts        # setReplicas, and the coordinator's placement records
      varsets.ts          # AES-256-GCM seal/open, content-addressed envelopes
      nodes.ts            # node registration, heartbeat, liveness, lease-gated removal
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
      rendezvous.ts       # assignNodes: environment + live nodes -> the nodes serving it (pure)
      replicas.ts         # how many nodes an environment asks for, and the defaults (pure)
      routes.ts           # renderRoutes: environments + ready processes -> hosts (pure)
      index.ts            # barrel
  agent/
    config.ts             # loadAgentConfig: file + env + flags, runtime-agnostic
    middleware.ts         # bearer auth guard + RFC 9457 error rendering
    app.ts                # createAgentApp: AgentContext and the HTTP routes
    serve.ts              # startAgent: binds the app to config.node.listen
    reconcile.ts          # createReconciler: the loop, its status, one pass at a time
    coordinator.ts        # createCoordinator: the lease loop, its fence, assignment and the reap
    heartbeat.ts          # createHeartbeat: this node saying it is still there, every 30s
    deploys.ts            # createDeployService: accept an artifact, publish it, watch it land
    _assign.ts            # internal: the coordinator deciding which nodes serve what
    _execute.ts           # internal: carries out one plan (activate/start/gate/stop)
    _desired.ts           # internal: desired state read out of the registry, filtered to this node
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
      env.ts              # `scalo env`: retire, unretire and delete environments
      varset.ts           # `scalo varset`: seal a variable file, list what an environment carries
      trust.ts            # `scalo trust`: which CI issuers may deploy a project
      wg.ts               # `scalo wg`: set this node up on the tunnel, refresh its peers
    _agent.ts             # internal: one call to a node's API, and the key that signs it
    _bootstrap.ts         # internal: the steps between reading the config and serving
    _environments.ts      # internal: the two ways `scalo env` reaches an installation
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
      traefik.ts          # createTraefikDriver() — renders + caches the config Traefik polls
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
- **One routing, two ingresses, and they are reached in opposite directions.** `ingress.driver` selects which ingress a node drives — `caddy` or `traefik` (`--ingress-driver`, `SCALO_INGRESS_DRIVER`); naming a Caddy admin API on its own still means Caddy, because that setting predates there being a choice. Both drivers are handed the SAME `IngressDesired` after every reconcile pass, and `test/ingress-parity.test.ts` holds them to it: each render is reduced to its `host → upstream` pairs and the two must be identical, whatever the formats do. What differs is the direction. **Caddy is PUSHED:** the driver calls its admin API, owns only the routes carrying its `scalo_` `@id` prefix inside a server the operator also writes into, and adds before it removes so a host that moves is never served by neither. **Traefik PULLS:** its `http` provider polls a URL, so `apply` makes no call at all — it renders the configuration and caches it, the agent serves that cache unauthenticated at `GET /v1/ingress/traefik` (a 404 there means this node drives no polled ingress; the seam is `PullingIngressDriver.snapshot()`, checked structurally because the agent may not import a driver), and Traefik picks the change up on its next poll. So Traefik needs no address configured on the node at all — it is the one doing the asking — and a Caddy setting written alongside it is REFUSED rather than ignored, because it means the operator has misread which of the two applies. Three consequences are worth knowing before choosing: a change reaches traffic one poll later rather than at once; there is no coexistence question, since the document the node serves IS everything that provider routes and the operator's own routers come from their other providers; and **an empty routing must be rendered as an empty document `{}`** — Traefik's decoder REFUSES `{"http":{"routers":{},"services":{}}}` ("routers cannot be a standalone element"), treats the poll as failed, and a failed poll leaves the last configuration in place, so the obvious rendering would keep serving an environment the node has stopped. A host nothing routes also answers differently: Traefik gives `404 page not found`, Caddy an empty `200`.
- **A deploy is accepted, then carried out.** `POST /v1/deploys` takes multipart `meta` + `artifact`, ensures the project and environment exist — reading the environment before creating one, because a deploy asks only that it _exist_ and must not be refused for disagreeing with settings it never named, such as the `ephemeral` of a preview environment — answers `202` with a `Location`, and does the rest in the background: publish the artifact through `DeployRunner` (unpack, run the builder, read back the runtime's version id), record an immutable build, and — when the upload asked to flip — move the alias and watch the reconcile loop until a process serving that build is ready. Exactly three states are final (`deployed`, `routed`, `failed`), so a client polls until it reaches one. Missing the routing deadline is a warning and never an error: the build exists and the loop keeps trying. Deploy status is soft state held in memory, so a restarted agent forgets deploys in flight while the registry remembers everything they had already committed.
- **A node is its keypair, and it keeps it.** The id a node registers under and the Ed25519 pair that speaks for it live together in `<stateDir>/node.json`, written `0600` in a directory created `0700`, and are generated only on the first boot. The record in the registry is rewritten on every boot because it is derived state, but the identity behind it is not: a node that regenerated its key would leave a stale public key in the registry and have every token it signs rejected for reasons nothing on it explains. A state file that cannot be read as an identity therefore refuses the boot rather than being replaced — deleting it is a deliberate act — and the configuration only ever _pins_ an id, which replaces the identity outright when it changes.
- **An unclassified network is refused, not assumed.** Every address a node exposes carries traffic that commands it. As soon as the agent listener, the internal listener, the advertised address or `runtime.bindHost` reaches past loopback, `scalo up` refuses to boot until `transport.driver` says which network that is: `wireguard` to tunnel it, `none` to state that it is already private and trusted. There is no default, because the safe-looking one silently exposes a node and the other refuses working setups. A loopback-only node crosses nothing and needs neither.
- **Runtime listeners bind loopback until a fleet needs otherwise.** A runtime process listens on `runtime.bindHost` (default `127.0.0.1`), which is everything a single node needs: its own ingress and its own readiness probe are on that host. A fleet spread over several nodes is the case that needs more — one cell has one owner, and a request that lands on a node that does not own it is forwarded to the one that does, dialling the address that node advertises. Nothing answers there while the listeners are on loopback, so cross-node cell traffic simply cannot work; that is what `runtime.bindHost` widens. It is not a tuning knob: the runtime's peer listener authenticates nobody, so widening it exposes an unauthenticated surface and is therefore gated on the same transport decision as every other exposed address.
- **A coordinator that loses its renewal stops being one, immediately.** The lease in the bucket is the whole election — there is no consensus protocol. `createCoordinator` renews every `ttlMs/3`, and a renewal that does not land drops the node to candidate _before_ any coordinator-only work runs on that tick, whether the lease was taken away or the bucket merely could not be reached. The two are indistinguishable from the node's side and the safe reading of both is the same, because the node that superseded it is already acting. Deletes cannot be conditional, so the lease is the only thing keeping two reapers apart; a reap that fails for any other reason is recorded, the lease is kept, and the next tick plans again from fresh state.
- **Lease-gated work is forwarded, not refused.** Only the coordinator can carry out a deletion, but which node that is at any moment is the installation's business rather than the operator's. Any node accepts `DELETE /v1/environments/:project/:env`: it does the work when it holds the lease, offers itself once when nobody holds one, and otherwise forwards the request to the holder and returns that answer verbatim. The hop carries a FRESH node token this node signed for itself — never the caller's, which is single-use and was already spent verifying it here — and an `x-scalo-proxied: 1` header, so a forward that lands on a node that does not coordinate either is answered `503` instead of being forwarded again.
- **An environment is served with its variables or not at all.** A node opens its environments' varsets with one AES-256 key, read from a file the operator configures. An environment whose varset this node cannot open — no key, the wrong key, an altered envelope — is recorded as a failure of that one environment and keeps whatever process it already had; the pass carries on and every other environment is served. Starting it unconfigured would come up, pass its readiness gate and serve requests against whatever the code falls back to, which is a misconfiguration nothing reports.
- **Key material is the operator's, never scalo's.** A WireGuard identity is an X25519 keypair, and there is no scalar multiplication on the web-crypto surface every runtime shares. So scalo computes none: `scalo wg init` reads `<stateDir>/wg-private.key` if it is there, shells out to `wg genkey` if it is not, and refuses with the exact command to run if there is neither — the public half likewise, from a file beside it or from `wg pubkey`. Both halves are then persisted `0600`, so a node that has been set up boots on a host that never had wireguard-tools. Bringing the interface up is the operator's step too, because it needs a kernel module and NET_ADMIN: scalo renders `wg0.conf` from the registry's own peer list — every node publishes its key, endpoint and address in its record — prints `wg-quick up`, and stops. A peer's `AllowedIPs` is its own address alone (`/32`, `/128`), never the subnet its record names, because a peer allowed the whole subnet claims every other node's route. Assisted, never magical: an amateur curve implementation inside an operator's private network is a worse outcome than an error message.
- **A tunnelled node lives at its tunnel address.** When `transport.driver` is `wireguard`, `runtime.bindHost` and the advertised address both default to the node's own WireGuard address rather than to loopback or to whatever wildcard the listener bound — inside a tunnel those are the only addresses a peer can actually dial. Explicit configuration still wins. The tunnel's own settings are required in that mode and refused for by name; configured on a node running another transport they are reported as ignored rather than quietly kept.
- **An environment runs on the nodes it was given, and everywhere until it is given any.** Each environment declares how many nodes should serve it (`replicas`: a whole number, or `"all"`), the coordinator decides WHICH nodes by rendezvous hashing over the live ones — `sha256("<project>/<env>\n<nodeId>")`, highest scores win — and writes that to `_scalo/placement/<project>/<env>.json` under its own fence, only when the decision changed. Each node then serves an environment only when the record names it. The defaults preserve exactly what scalo did before placement existed: long-lived environments resolve to `"all"`, ephemeral previews to `1`, and a single-node installation cannot tell the difference. The load-bearing rule is the missing record: **an environment with no placement object is served by every node**, because that is the state of a bootstrap, of a fresh installation, and of every node running a build that predates these records — reading it as "not mine" would take an installation off the air the first time it upgraded. Rendezvous hashing is chosen for stability rather than balance: a node joining or dying only moves the environments that node was involved in, so nothing else restarts.
- **A coordinator that cannot see the fleet decides nothing.** Placement counts a node live while its `heartbeatAt` — refreshed every 30s, stamped at registration, stopped on shutdown — is younger than three intervals, falling back to `capacity.probedAt` for a record written by a node too old to beat. When NO node is live the assignment pass REFUSES (`placement-unavailable`) and writes nothing at all, because an unreachable bucket, a jumped clock and a fleet mid-restart all read as an empty node list, and the decision that follows from an empty list is "nothing is served anywhere" — every node would stop every process it runs over a hiccup. The last decision standing keeps whatever is running, running. The same fence that gates the reap gates this: a decision recorded at a higher fence belongs to the coordinator that superseded this one and is never overwritten, and a lost CAS is skipped rather than retried, because the winner is another coordinator.
- **A node that is leaving says so, rather than being found out.** A node that simply stops is indistinguishable from one that crashed, and a crash is only noticed once the last heartbeat has aged past the liveness window — 90 seconds in which the coordinator still counts the node among those it hands work to, and its single-replica environments are placed on a process that is already gone. So the FIRST step of a graceful shutdown, before the reconciler, the coordinator or any process is stopped, is a CAS update writing `drainingAt` onto the node's own record; `isNodeLive` then answers false regardless of how fresh the heartbeat is, and the next assignment pass moves the work. It is best effort and never throws — a bucket that cannot be reached must not hold a shutdown open, and failing it the fleet falls back to exactly the timing it had before. Registration rewrites the record wholesale, which is what un-drains a restarted node: a node that has started is a node that serves. There is no hitless handover behind this — the receiving node starts its own process while the leaving one stops — so what draining buys is the delay, not the overlap.
- **An environment is retired before it is deleted.** Deleting is the one act nothing in the registry can undo, and a long-lived environment is the name that outlives every build it ever served — its domains, its variables and its history go with it. So it takes two steps: `retiredAt` marks the environment as on its way out, which takes it out of `readDesired` and therefore out of every node's processes and out of the routing (`renderRoutes` is unchanged and needs to be — it renders what a node actually runs), makes the coordinator give it no nodes and drop its placement record, and makes `/v1/ingress/ask` answer 404 for its claimed domains so no certificate is minted for a name that is going away. Only then, once the grace has run (24h by default, caller-overridable), may it be deleted; the reaper proposes it on the same terms, ephemerality notwithstanding. Every refusal names the route forward — which of ephemeral, retired-past-grace or forced applies, and how much of the grace is left — because a refusal that only restates its rule sends an operator looking for documentation. Retiring is REVERSIBLE for the whole grace and idempotent in the way that matters: retiring twice keeps the first timestamp, because restamping would silently restart the wait. `force` is the single escape hatch and skips both requirements, but never the coordinator lease.
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
