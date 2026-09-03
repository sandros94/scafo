#!/usr/bin/env bash
# Compile the tested `dist/` output with Deno. Artifacts and checksums go in `build/`.
# Requires Node, pnpm, and Deno on PATH; see https://docs.deno.com/runtime/getting_started/installation/.

set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
stage="${root}/build/.stage"
out="${root}/build"

# Targets use `<os>-<arch>:<deno target triple>`; node daemons are Linux-only.
readonly TARGETS=(
  "linux-amd64:x86_64-unknown-linux-gnu"
  "linux-arm64:aarch64-unknown-linux-gnu"
)

# Deno seals these permissions into the binary. Omit FFI and dynamic imports.
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
  require_cmd pnpm

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

# Stage built output, a minimal manifest, and runtime dependency import map outside the development tree.
stage_sources() {
  local dist="${root}/dist/cli/index.mjs"
  [ -f "$dist" ] || die "dist/cli/index.mjs is missing; run \`pnpm build\`"
  if head -n 5 "$dist" | grep -q 'from "\.\./\.\./src/'; then
    die "dist/ holds a stub build (\`obuild --stub\`); run \`pnpm build\` for a real one"
  fi

  rm -rf "$stage"
  mkdir -p "$stage"
  cp -R "${root}/dist" "${stage}/dist"

  # The CLI resolves `../../package.json`; keep only fields it reads to avoid dependency resolution.
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const version = process.env.SCAFO_VERSION || manifest.version;
    fs.writeFileSync(
      process.argv[2],
      JSON.stringify({ name: manifest.name, version, type: "module" }, null, 2) + "\n",
    );
  ' "${root}/package.json" "${stage}/package.json"

  # Generate bare and subpath entries from installed runtime dependencies.
  # shellcheck disable=SC2016 # `${...}` inside are JS template literals, not shell
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [manifestPath, modulesDir, outPath] = process.argv.slice(1);
    const deps = JSON.parse(fs.readFileSync(manifestPath, "utf8")).dependencies ?? {};
    const imports = {};
    for (const name of Object.keys(deps).sort()) {
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
  ' "${root}/package.json" "${root}/node_modules" "${stage}/deno.json"

  # Deno embeds mtimes; normalize staged files for reproducible same-cache builds.
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

  # Publish the installer-verifiable checksum beside each binary.
  (cd "$out" && sha256sum "scafo-${name}" > "scafo-${name}.sha256")
  say "        $(cd "$out" && cat "scafo-${name}.sha256") ($(du -h "$binary" | cut -f1))"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "\"$1\" is not on PATH; see the header of this script"
}

say() { printf 'scafo: %s\n' "$*" >&2; }
die() { printf 'scafo: %s\n' "$*" >&2; exit 1; }

main "$@"
