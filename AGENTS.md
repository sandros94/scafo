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
- **Type check:** `pnpm typecheck` (uses `tsc` from TypeScript 7)
- **Lint:** `pnpm lint` (oxlint + oxfmt --check)
- **Format:** `pnpm fmt` (automd + oxlint --fix + oxfmt)
- **Benchmarks:** `pnpm bench`
- **Dev playground:** `pnpm dev` (runs `playground/main.ts` with bun)

## Architecture

### Module structure (each is a separate export path)

- `scalo` — barrel: `ScaloError` and friends, the registry types, plus the `utils`, `registry`, `auth` and `capacity` namespaces
- `scalo/registry` — registry operations: keys, CAS document helpers, coordinator lease, projects, builds, environments, varsets, nodes, trust, domains, reaper
- `scalo/auth` — node/operator EdDSA tokens and workload OIDC verification
- `scalo/capacity` — cgroup v2 parsing and the capacity planning formulas
- `scalo/drivers/store/uns3` — `CasStore` backed by an S3-compatible bucket via [`uns3`](https://github.com/sandros94/uns3)
- `scalo/drivers/store/memory` — in-process `CasStore` with identical CAS semantics, for tests and local development
- `scalo/drivers/host/node` — `HostReader` probing cgroup v2 and host totals on Node-compatible runtimes

### Source layout

```
src/
  index.ts                # barrel: error + types, utils/registry namespaces
  core/
    error.ts              # ScaloError, ScaloErrorCode, RFC 9457 toProblem()
    types/
      store.ts            # CasStore, CasHeaders, StoredObject
      registry.ts         # registry record shapes + the bucket key each lives at
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
  drivers/
    store/
      uns3.ts             # createUns3Store()
      memory.ts           # MemoryCasStore, createMemoryStore()
    host/
      node.ts             # createNodeHostReader() — node:fs/promises + node:os
```

### Key design patterns

- **CAS-only mutation:** every registry write goes through `CasStore.put()` with a precondition. A failed precondition surfaces as `ScaloError("cas-conflict")`; callers recover by re-reading and retrying (`utils.withRetry`).
- **`src/core/**` has zero foreign runtime dependencies.** It may not import third-party packages — only web-standard globals (`crypto.subtle`, `TextEncoder`, `fetch`). The one exception is [`unjwt`](https://github.com/sandros94/unjwt) inside `src/core/auth/**`: own runtime-agnostic libraries are building blocks, not dependencies to avoid. Only `src/drivers/**` may import `uns3` or runtime modules (`node:*`).
- **Core never reaches for a runtime.** Anything impure lives behind an interface core defines and a driver implements (`CasStore`, `HostReader`); the caller wires the two together.
- **One rejection for every bad token:** `src/core/auth` answers expired, replayed, unknown-key, forged and malformed tokens with the same `ScaloError("auth-invalid")` — no message, no detail, reason in `cause`. Only a trust-policy denial is distinguishable (`trust-mismatch`), because that is authorization, not authentication.
- **Single error type:** `ScaloError` carries a stable `code` plus an HTTP `status`, and renders to an RFC 9457 problem document. Messages may change, codes may not.
- **Single multi-input bundle:** all entry points are `input`s of one `type: "bundle"` in `build.config.ts`, so rolldown code-splits shared core into `dist/_chunks/*`. Adding an entry = add its input (and any runtime dep to `external`).
- **Store drivers are interchangeable:** `MemoryCasStore` implements the same conditional-write contract as the S3 driver, so registry logic can be tested without a bucket.

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
