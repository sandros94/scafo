# The scafo node image: the daemon, the runtime it supervises, and the builder
# it hands deploys to — everything one node needs and nothing it does not.
#
#   docker build -t scafo .
#   docker run --rm scafo --help
#
# See examples/compose.yaml for a runnable single-host stack and
# examples/kubernetes/ for the same node as a Deployment.

# ---------------------------------------------------------------------------
# celld — the runtime under every application this node serves.
#
# PINNED BY DIGEST as well as by tag, and deliberately the only thing here that
# is. A tag is a pointer its publisher can move; this binary runs every
# customer's code and holds every cell's replication chain, so the bytes it is
# built from must be the same ones that were tested. The digest is the
# multi-architecture index, so amd64 and arm64 both resolve from it.
#
# Moving to a new celld is an explicit edit of both lines, and belongs with the
# rules the driver encodes (src/drivers/runtime/celld.ts) — above all that idle
# eviction stays off until enabling it becomes a deliberate policy, and that
# durability stays pinned to the bucket, not to 0.3.0's write-behind default.
FROM ghcr.io/denoland/celld:0.3.0@sha256:f47d97c2980aa98aef1d9c42205a313442f48acb606c5987dbb9b32983a23aaf AS celld

# ---------------------------------------------------------------------------
# Build: the repository's own toolchain, which does not survive into the image.
FROM node:24-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# The manifest and the lockfile alone, so the install layer is only invalidated
# by a dependency change rather than by every edit to src/.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json build.config.ts ./
COPY src ./src
RUN pnpm build

# What dist actually loads at runtime: the packages `build.config.ts` marks
# external (uns3, unjwt, h3, confbox, citty, tar) plus esbuild, which the deploy
# intake resolves through `createRequire` rather than importing. Everything else
# was bundled into dist/ and everything that built it is dropped here.
RUN pnpm prune --prod --ignore-scripts

# esbuild ships its compiled binary in a per-platform package and publishes no
# API saying where that package landed; this is the resolution esbuild performs
# for itself, run once here so the image carries the answer instead of the node
# working it out on every deploy. Written without a template literal on purpose:
# `${...}` inside a RUN reaches the shell, not node.
RUN set -eux; \
  bin="$(node -e 'const {createRequire}=require("node:module"); \
    const here=createRequire(process.cwd()+"/"); \
    const fromEsbuild=createRequire(here.resolve("esbuild")); \
    process.stdout.write(fromEsbuild.resolve("@esbuild/"+process.platform+"-"+process.arch+"/bin/esbuild"))')"; \
  install -D -m 0755 "$bin" /out/esbuild; \
  /out/esbuild --version

# ---------------------------------------------------------------------------
# The image an operator runs.
FROM node:24-slim

# The bucket is reached over TLS in every real installation, and node:*-slim
# ships no root store at all.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
COPY --from=build /out/esbuild /usr/local/bin/esbuild

# Pinned to the image's own binary so deploy intake never resolves esbuild
# across packages at runtime — the resolution depends on the node_modules layout
# it happens to be started under, and a node's builder must not.
ENV ESBUILD_BINARY_PATH=/usr/local/bin/esbuild

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Read for its version alone, which the daemon announces and registers with.
COPY package.json ./

# A node's identity — its id and the Ed25519 pair that speaks for it — is the one
# thing it must keep across restarts, and it is written 0600 into a directory
# created 0700. Owned here so a volume mounted over it inherits the ownership,
# and it is also the user's home, so anything else that reaches for $HOME lands
# in the same place.
RUN groupadd --gid 10001 scafo \
  && useradd --uid 10001 --gid scafo --home-dir /var/lib/scafo \
  --shell /usr/sbin/nologin scafo \
  && install -d -o scafo -g scafo -m 0700 /var/lib/scafo
ENV SCAFO_STATE_DIR=/var/lib/scafo

USER scafo

# The node API. NOT bound here: `node.listen` defaults to 127.0.0.1:7400, and
# widening it to 0.0.0.0 is what makes the node refuse to boot until
# `transport` says whether that network is a tunnel or a trusted private one.
# That acknowledgement is the operator's, so the examples pass both together and
# this image ships neither.
EXPOSE 7400

# STOP GRACE MUST BE AT LEAST 35 SECONDS. This is not a tuning preference.
#
# On SIGTERM the daemon marks itself draining, releases the coordinator lease,
# stops reconciling, closes its listener, and only then stops the celld
# processes it supervises — each of which is given 30s between SIGTERM and
# SIGKILL and drains its in-flight requests for the first 25s of it. A container
# killed before that has run leaves requests dropped mid-flight and a node the
# fleet has to time out instead of being told about.
#
#   compose:    stop_grace_period: 35s
#   kubernetes: terminationGracePeriodSeconds: 35
#   docker run: docker stop -t 35 <container>
#
# Docker's own default is 10s, which is not enough. See examples/.
STOPSIGNAL SIGTERM

ENTRYPOINT ["node", "/app/dist/cli/index.mjs"]
CMD ["sail"]
