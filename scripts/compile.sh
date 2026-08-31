#!/usr/bin/env bash
#
# Compiles the `scafo` binary — one self-contained executable that is both the
# node daemon and the CLI — out of the BUILT output in dist/, never out of src/.
#
#   pnpm compile                      # every default target
#   pnpm compile linux-amd64          # one of them
#   SCAFO_VERSION=1.2.3 pnpm compile  # what `scafo --version` and a node report
#
# Artifacts land in build/ as `scafo-<os>-<arch>`, each beside a `.sha256` an
# installer can verify it against. build/ is gitignored and is not touched by
# `pnpm build`.
#
# WHY IT COMPILES dist/ AND NOT src/: dist/ is what is tested, what the image
# runs and what is published to npm. Compiling the sources separately would make
# the binary a second build of the project that nothing else exercises — the two
# would drift, and the first anyone would know is a node behaving unlike its own
# test suite.
#
# WHAT IT NEEDS: Deno (the compiler), and Node with pnpm (the build). Deno is a
# build-time dependency only; nothing at runtime needs it. Install it without
# root with:
#
#   curl -fsSL https://deno.land/install.sh | sh   # into ~/.deno
#
# WHAT THE BINARY STILL DOES NOT CARRY, and must not: celld (the runtime), an
# ingress, wireguard-tools, and esbuild. esbuild in particular is a per-platform
# native executable that the deploy path hands to `celld deploy` by PATH —
# `ESBUILD_BINARY_PATH` names it — so embedding it would put a second copy of a
# toolchain inside a daemon that only ever passes its path along. See
# scripts/install.sh, which installs the prerequisites beside the binary.

set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
stage="${root}/build/.stage"
out="${root}/build"

# The npm package `deno compile` must NOT resolve. It is a runtime dependency of
# the project (the deploy path locates the executable it ships), but the binary
# reaches that executable through ESBUILD_BINARY_PATH or PATH, and resolving the
# package here would embed ~10MB of native toolchain per platform in every copy.
readonly EXCLUDED_DEPS="esbuild"

# Targets, as `<os>-<arch>:<deno target triple>`. Only Linux is built by default:
# a node daemon supervises cgroup-limited processes and drives an ingress, which
# is a Linux host. The binary is also the CLI, and `deno compile --target` can
# produce macOS and Windows builds of it — add them here when an operator command
# needs to run somewhere a node never will.
readonly TARGETS=(
  "linux-amd64:x86_64-unknown-linux-gnu"
  "linux-arm64:aarch64-unknown-linux-gnu"
)

# The permission set the binary is sealed with, and the reasoning is the point.
#
# `deno compile` bakes permissions in: whatever is not granted here can never be
# granted by the operator later. Four of these are UNBOUNDED BY THE PRODUCT
# rather than by laziness — every one of their targets is named in configuration
# an operator writes, so a value pinned at compile time would refuse a documented
# setting on somebody's host:
#
#   --allow-read   the state directory (SCAFO_STATE_DIR, anywhere), the config
#                  file, the varset key file, the ingress access log, and the
#                  directory `scafo deploy` packs — which is any directory a user
#                  points it at
#   --allow-write  the state directory (node identity, storage token, WireGuard
#                  keys), the rendered wg0.conf, and the temp directory a deploy
#                  is staged under
#   --allow-net    the S3 endpoint, a node's own listeners, another node's API,
#                  Caddy's admin API, a runtime process's health and probe
#                  addresses, and any OIDC issuer a project trusts
#   --allow-run    `celld` (the runtime, and `runtime.celldBin` may name it
#                  anywhere on the host) and `wg` (key generation only —
#                  `wg-quick` is PRINTED for the operator to run, never spawned)
#   --allow-env    ~60 names: SCAFO_*, AWS_*, the CELLD_* the runtime driver
#                  composes, ESBUILD_BINARY_PATH, XDG_STATE_HOME, and the
#                  PATH/HOME/TMPDIR/TZ/RUST_LOG a supervised process inherits.
#                  Enumerable, and deliberately not enumerated: the list would
#                  have to include whatever the h3/srvx/tar/uns3 dependency tree
#                  reads for itself, and a name missing from it is not a denied
#                  read but an uncatchable NotCapable that kills the daemon at
#                  runtime, on whichever host first sets it
#   --allow-sys    `os.homedir()` for the default state directory and
#                  `process.getuid()`
#
# What is DENIED is what is left off: --allow-ffi (no dependency loads a native
# library, and dlopen would be a way around every line above) and --allow-import
# (nothing is fetched and evaluated at runtime; the module graph is sealed in the
# binary). Those two are the ones that can be denied without denying a feature,
# which is exactly why `-A` is not what ships.
readonly PERMISSIONS=(
  --allow-env
  --allow-read
  --allow-write
  --allow-net
  --allow-sys
  --allow-run
)

main() {
  require_cmd deno
  require_cmd node

  local selected=("$@")
  if [ "${#selected[@]}" -eq 0 ]; then
    local entry
    for entry in "${TARGETS[@]}"; do selected+=("${entry%%:*}"); done
  fi

  say "deno   $(deno --version | head -n 1)"
  say "node   $(node --version)"

  if [ "${SCAFO_COMPILE_SKIP_BUILD:-0}" = "1" ]; then
    say "build  skipped (SCAFO_COMPILE_SKIP_BUILD=1)"
  else
    say "build  pnpm build"
    (cd "$root" && pnpm build >/dev/null)
  fi

  stage_sources

  local name
  for name in "${selected[@]}"; do
    compile_target "$name"
  done

  say "done   $out"
}

# Lays out the ONE directory `deno compile` is pointed at: the built output, the
# manifest beside it, and an import map naming every npm dependency by the
# version that is actually installed.
#
# It is a directory of its own because the repository root is the wrong place to
# compile from. Deno resolves npm packages through node_modules when it finds
# one, and this project's node_modules is the DEVELOPMENT tree — the whole
# toolchain, esbuild's native binaries included. Compiling from the root embeds
# all of it: measured at 299MB against 113MB from here.
stage_sources() {
  local dist="${root}/dist/cli/index.mjs"
  [ -f "$dist" ] || die "dist/cli/index.mjs is missing; run \`pnpm build\`"
  if head -n 5 "$dist" | grep -q 'from "\.\./\.\./src/'; then
    die "dist/ holds a stub build (\`obuild --stub\`); run \`pnpm build\` for a real one"
  fi

  rm -rf "$stage"
  mkdir -p "$stage"
  cp -R "${root}/dist" "${stage}/dist"

  # The manifest the CLI reads its version out of, at the path it looks for it:
  # `../../package.json` from dist/cli/index.mjs. Only the three fields that are
  # read — a copy of the real one would carry `dependencies`, which Deno would
  # then try to resolve, esbuild included.
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const version = process.env.SCAFO_VERSION || manifest.version;
    fs.writeFileSync(
      process.argv[2],
      JSON.stringify({ name: manifest.name, version, type: "module" }, null, 2) + "\n",
    );
  ' "${root}/package.json" "${stage}/package.json"

  # The import map, generated rather than written down: every runtime dependency
  # at the version installed in node_modules, so the binary and `pnpm test` are
  # built against the same code and the map can never drift from the lockfile.
  # Each package gets a bare entry and a trailing-slash one, because subpaths
  # (`unjwt/jwk`) resolve through the latter.
  # shellcheck disable=SC2016 # `${...}` inside are JS template literals, not shell
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [manifestPath, modulesDir, excluded, outPath] = process.argv.slice(1);
    const deps = JSON.parse(fs.readFileSync(manifestPath, "utf8")).dependencies ?? {};
    const skip = new Set(excluded.split(",").filter(Boolean));
    const imports = {};
    for (const name of Object.keys(deps).sort()) {
      if (skip.has(name)) continue;
      const own = path.join(modulesDir, name, "package.json");
      if (!fs.existsSync(own)) {
        throw new Error(`${name} is not installed; run \`pnpm install\``);
      }
      const { version } = JSON.parse(fs.readFileSync(own, "utf8"));
      imports[name] = `npm:${name}@${version}`;
      imports[`${name}/`] = `npm:/${name}@${version}/`;
    }
    fs.writeFileSync(
      outPath,
      JSON.stringify({ nodeModulesDir: "none", imports }, null, 2) + "\n",
    );
  ' "${root}/package.json" "${root}/node_modules" "$EXCLUDED_DEPS" "${stage}/deno.json"

  # ONE MTIME FOR EVERY STAGED FILE, AND WITHOUT IT THE ARTIFACT IS NOT
  # REPRODUCIBLE. `deno compile` records each embedded file's modification time
  # in the virtual filesystem it seals into the binary ("t":<epoch ms> per
  # entry), so two compiles of BYTE-IDENTICAL sources differ by exactly those
  # stamps — measured at 79 bytes, which is enough to make a published checksum
  # meaningless. dist/ is rewritten by every `pnpm build` and the staging copy
  # gets today's date, so both have to be flattened here.
  #
  # SOURCE_DATE_EPOCH is honoured because that is the convention every
  # reproducible-build toolchain already reads; the default is the epoch itself,
  # which is what makes two runs of this script agree without anyone setting
  # anything.
  #
  # WHAT THIS DOES NOT MAKE REPRODUCIBLE: the npm dependencies come out of Deno's
  # own cache, and their stamps are whenever that machine downloaded them. Same
  # machine, same warm cache, same bytes — a second machine needs its cache
  # normalised too, and that is not something this script owns.
  find "$stage" -exec touch -h -d "@${SOURCE_DATE_EPOCH:-0}" {} +
}

compile_target() {
  local name="$1" triple="" entry
  for entry in "${TARGETS[@]}"; do
    [ "${entry%%:*}" = "$name" ] && triple="${entry#*:}"
  done
  [ -n "$triple" ] || die "unknown target \"${name}\"; one of: $(printf '%s ' "${TARGETS[@]%%:*}")"

  mkdir -p "$out"
  local binary="${out}/scafo-${name}"
  say "compile ${name} (${triple})"

  (cd "$stage" && deno compile \
    --quiet \
    "${PERMISSIONS[@]}" \
    --target "$triple" \
    --output "$binary" \
    dist/cli/index.mjs)

  # The checksum an installer verifies the download against; see
  # scripts/install.sh, which refuses a binary whose bytes do not match.
  (cd "$out" && sha256sum "scafo-${name}" > "scafo-${name}.sha256")
  say "        $(cd "$out" && cat "scafo-${name}.sha256") ($(du -h "$binary" | cut -f1))"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "\"$1\" is not on PATH; see the header of this script"
}

say() { printf 'scafo: %s\n' "$*" >&2; }
die() { printf 'scafo: %s\n' "$*" >&2; exit 1; }

main "$@"
