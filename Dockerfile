# The container engine's client the runtime stage carries, pinned by release and
# by each architecture's checksum, the way scripts/install.sh pins Celld.
ARG DOCKER_VERSION=29.8.1
ARG DOCKER_SHA256_AMD64=d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70
ARG DOCKER_SHA256_ARM64=667395fbffab52901b80181dfbb39ea76da2fbd7642c4fbddd24e42146b07b48

# Pin the runtime by tag and multi-architecture digest.
FROM ghcr.io/denoland/celld:0.6.2@sha256:b85983dcf410bcf710bbc30f400d8654123cb2b541ca4d84d7e299009a6ee97a AS celld

# Build stage.
FROM node:24-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# Keep dependency installation cacheable across source changes. `patches/` is
# part of the manifest: an install without it cannot resolve a patched package.
COPY patches ./patches
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json build.config.ts ./
COPY src ./src
RUN pnpm build

# Extract the platform-specific esbuild binary before pruning dependencies.
RUN set -eux; \
  bin="$(node -e 'const {createRequire}=require("node:module"); \
    const here=createRequire(process.cwd()+"/"); \
    const fromEsbuild=createRequire(here.resolve("esbuild")); \
    process.stdout.write(fromEsbuild.resolve("@esbuild/"+process.platform+"-"+process.arch+"/bin/esbuild"))')"; \
  install -D -m 0755 "$bin" /out/esbuild; \
  /out/esbuild --version

# Keep only runtime dependencies.
RUN pnpm prune --prod --ignore-scripts

# The engine client's download. The architecture is read off the stage itself
# rather than from a build argument, because this file is also built by builders
# that fill none; the bundle carries a whole engine, and only the client binary
# leaves here.
FROM node:24-slim AS client
ARG DOCKER_VERSION
ARG DOCKER_SHA256_AMD64
ARG DOCKER_SHA256_ARM64
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
  case "$(dpkg --print-architecture)" in \
  amd64) arch='x86_64'; expected="$DOCKER_SHA256_AMD64" ;; \
  arm64) arch='aarch64'; expected="$DOCKER_SHA256_ARM64" ;; \
  *) echo "no container client is pinned for $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/client.tgz \
  "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_VERSION}.tgz"; \
  echo "${expected}  /tmp/client.tgz" | sha256sum -c -; \
  tar -xzf /tmp/client.tgz -C /tmp docker/docker; \
  install -D -m 0755 /tmp/docker/docker /out/docker

# Test host stage: the same Celld and esbuild the image ships, with no
# application, for suites that bind-mount a worktree's build into a container.
# Not part of the default build; build it with `--target probe -t scafo-probe`.
FROM node:24-slim AS probe

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
COPY --from=build /out/esbuild /usr/local/bin/esbuild
ENV CELLD_ESBUILD=/usr/local/bin/esbuild

ENTRYPOINT []
CMD ["node"]

# Runtime stage.
FROM node:24-slim

# The slim base lacks a root certificate store.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
COPY --from=build /out/esbuild /usr/local/bin/esbuild

# The engine's client, and no engine. `celld deploy` builds or pulls a container
# image through this CLI on the node that accepts the deploy, so a node that
# takes a deployment with a container class needs it on PATH. The binary grants
# nothing on its own: it reaches an engine only through a socket the operator
# mounts, and mounting one is their decision.
COPY --from=client /out/docker /usr/local/bin/docker

# Default Celld source builds to the bundled esbuild binary.
ENV CELLD_ESBUILD=/usr/local/bin/esbuild

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The daemon reads the package version at runtime.
COPY package.json ./

# The node identity, the ingress token and the work directory of every runtime
# process this node supervises, in a private, non-login user's home directory.
RUN groupadd --gid 10001 scafo \
  && useradd --uid 10001 --gid scafo --home-dir /var/lib/scafo \
  --shell /usr/sbin/nologin scafo \
  && install -d -o scafo -g scafo -m 0700 /var/lib/scafo
ENV SCAFO_STATE_DIR=/var/lib/scafo

USER scafo

# The default listener remains loopback; wider binding requires explicit transport configuration.
EXPOSE 7400

# The probe reads the same configuration the daemon does, so it follows the
# listener wherever it is bound, the WireGuard default included. It reads the
# environment and the config file; a listener chosen with a `sail --listen` flag
# is invisible to it, so set SCAFO_LISTEN or node.listen instead.
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=3 CMD ["node", "/app/dist/cli/index.mjs", "health"]

# Configure at least 50s stop grace (or CELLD_SHUTDOWN_TOTAL_MS + 10s) so the node can drain.
STOPSIGNAL SIGTERM

# Keep the Node entrypoint as PID 1 in a private PID namespace.
ENTRYPOINT ["node", "/app/dist/cli/index.mjs"]
CMD ["sail"]
