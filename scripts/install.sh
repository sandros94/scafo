#!/bin/sh
#
# scafo — single-host bootstrap.
#
#   curl -fsSL https://raw.githubusercontent.com/sandros94/scafo/main/scripts/install.sh | sh
#
# Installs the four executables one scafo node is made of, each verified by
# sha256 before it is put anywhere:
#
#   scafo    the node agent and the CLI, one binary
#   celld    the runtime every deployed application runs on
#   caddy    the ingress that terminates TLS and routes to the runtime. By
#            DEFAULT this is scafo-caddy — see the next section — and
#            SCAFO_INSTALL_CADDY=plain installs upstream Caddy instead. Either
#            one is installed AS `caddy`, so nothing else on this host, in the
#            unit or in scripts/uninstall.sh, has to know which it is.
#   esbuild  the bundler `celld deploy` builds an artifact with
#
# and, when it is run by root on a host with systemd, the two units that keep the
# first and the third of them running.
#
# WHAT IT DELIBERATELY DOES NOT DO
#
#   * It does not start anything. A node cannot boot without a bucket to keep its
#     registry in, and those credentials are yours to write — see the closing
#     output, which names the file and the commands.
#   * It does not install wireguard-tools. A tunnel needs a kernel module and
#     NET_ADMIN; that is the distribution's package manager's business and the
#     hint is printed rather than acted on.
#
# WHICH CADDY, AND WHY THE DEFAULT IS THE ONE WITH THE MODULE
#
#   Plain Caddy keeps its certificates on this host's disk. That is PER-NODE
#   TLS: correct for one host, and on a fleet it means every node issues its own
#   certificate for the same names — fine until it is a rate limit. So the
#   default installed here is scafo-caddy: the same Caddy, built with the
#   `caddy.storage.scafo` module, which keeps the certificates, their keys and
#   the ACME account IN THE BUCKET and reaches them through this node's own
#   /v1/storage. It is given a loopback URL and a bearer token and holds no
#   bucket credential of its own, which is the point of the module: a TLS
#   terminator is the last process that should be able to address the bucket.
#
#   SCAFO_INSTALL_CADDY=plain opts down to upstream Caddy, pinned by the
#   checksums below, with an ingress config carrying no `storage` block. Moving
#   between the two is a re-run of this script with /etc/scafo/caddy.json moved
#   out of the way, because that file is never overwritten once it exists.
#
#   THE TOKEN IS NOT READABLE BY THE INGRESS, AND IS NOT MADE READABLE. The node
#   mints it 0600 as `scafo` inside a 0700 state directory, and the `caddy`
#   account cannot open it — widening either mode would hand every process
#   running as `caddy` the key to this node's storage API, a surface that
#   carries private keys in both directions. systemd is what crosses the gap:
#   `LoadCredential=` has the service manager read the file AS ROOT and place a
#   private read-only copy in $CREDENTIALS_DIRECTORY that only the service's own
#   UID may open, and the config points `token_file` at that copy. The comments
#   in render_ingress_unit() carry the first-boot ordering that goes with it,
#   which is the other half of the problem.
#
# WHAT IT READS FROM THE ENVIRONMENT
#
#   SCAFO_INSTALL_BASE     where the scafo binary and its .sha256 are fetched
#                          from. Defaults to this repository's GitHub releases,
#                          which do not exist yet — point it at your own
#                          `pnpm compile` output (a plain `python3 -m
#                          http.server` over build/ is enough) until they do.
#   SCAFO_VERSION          release tag to install (`latest`, or `1.2.3`).
#   SCAFO_SHA256           the expected checksum of the scafo binary. Defaults
#                          to whatever `<binary>.sha256` says beside it, which
#                          only proves the download was not corrupted — pin this
#                          to a checksum you got elsewhere to prove it is the
#                          binary you meant.
#   SCAFO_INSTALL_BIN_DIR  where the executables go. Defaults to
#                          /usr/local/bin as root or with passwordless sudo, and
#                          to ~/.local/bin otherwise.
#   SCAFO_INSTALL_CADDY    which ingress binary to install: "scafo" (the
#                          default — Caddy built with the caddy.storage.scafo
#                          module, from sandros94/scafo-certmagic) or "plain"
#                          (upstream Caddy, pinned below). Anything else is
#                          refused before a single byte is downloaded.
#   SCAFO_CADDY_BASE       where the scafo-caddy binary and its .sha256 are
#                          fetched from. Defaults to the latest release of
#                          sandros94/scafo-certmagic. The same shape as
#                          SCAFO_INSTALL_BASE and the same escape hatch: point
#                          it at your own `xcaddy build` output while there is
#                          no release to fetch.
#   SCAFO_CADDY_SHA256     the expected checksum of the scafo-caddy binary.
#                          Defaults to whatever `<binary>.sha256` says beside
#                          it, exactly as SCAFO_SHA256 does above and for the
#                          same reason: a "latest" URL cannot carry a constant
#                          pin, so integrity is verified by default and
#                          authenticity is yours to pin.
#   SCAFO_INSTALL_MIRROR   one base URL to fetch celld, upstream Caddy and
#                          esbuild from instead of their upstreams, keeping
#                          their file names. For a host that cannot reach GitHub
#                          or npm. IT CANNOT WEAKEN ANYTHING: the pinned
#                          checksums below are still what every download is held
#                          to, so a mirror serving other bytes is refused
#                          exactly as a corrupted download is. It covers only
#                          the three PINNED artifacts; `scafo` and `scafo-caddy`
#                          have bases of their own, above, because neither is
#                          pinned here for the reason the next paragraph gives.
#   SCAFO_INSTALL_SKIP_UNITS=1   never write systemd units.
#
# celld, upstream Caddy and esbuild are PINNED — a version and a sha256 per
# architecture, written down below and verified before install. Moving to a new
# one of them is an edit of those constants. The two binaries that come out of
# this project's own releases cannot be: both are fetched from a "latest" URL
# that a constant could only go stale against, so each is held to the `.sha256`
# published beside it — which catches a corrupted download and proves nothing
# about provenance — and SCAFO_SHA256 and SCAFO_CADDY_SHA256 are how an operator
# turns that into provenance. Every run says out loud which of the two it did.
#
# UNDOING IT: scripts/uninstall.sh, which stops and removes the units, the
# executables and /etc/scafo and KEEPS the state directory unless --purge says
# otherwise. It reads the manifest this script writes to /var/lib/scafo, and
# works without one. THE TWO SCRIPTS ARE ONE LIST IN TWO FILES — see the comment
# above the constants below.

set -eu

# ---------------------------------------------------------------------------
# What is installed, and the bytes it must be.
#
# THIS LIST AND scripts/uninstall.sh's CONSTANTS ARE ONE LIST IN TWO FILES AND
# MUST CHANGE TOGETHER. A binary, a unit, a directory or a system user added here
# and not there is one left on every host forever — and the failure is invisible,
# because an uninstall that removes four of five things still ends by reporting
# success. write_manifest() below records what cannot be derived (which bin
# directory, which accounts this run created); the uninstall does not depend on
# it, so these constants have to stay true on their own.
#
# The checksums were computed from the artifacts these URLs serve. Caddy's own
# `caddy_<v>_checksums.txt` publishes SHA-512; the sha256 below were taken from
# the same files after their SHA-512 matched that list, so verifying either one
# verifies the same bytes.

CELLD_VERSION='0.3.0'
CELLD_SHA256_amd64='cbfcfa5f6d7551b5316f6f4c9d7751c741a9ba2a2305dde8d5cb4d1b37fb34a6'
CELLD_SHA256_arm64='88a35070144408f902036076b7f88df38548ce4dda073fff27a6dd1f6d2bae28'

# Upstream Caddy, which is what SCAFO_INSTALL_CADDY=plain installs. The DEFAULT
# ingress is scafo-caddy, which carries no version here at all: it comes from a
# "latest" release URL and is verified against the .sha256 beside it, exactly as
# the scafo binary is. See fetch_caddy_scafo().
CADDY_VERSION='2.11.4'
CADDY_SHA256_amd64='527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9'
CADDY_SHA256_arm64='52d42ae12b3462097e9868da6dfed3c9648ae12edd3b3638102312af84cb6904'

ESBUILD_VERSION='0.28.2'
ESBUILD_SHA256_amd64='9573bb2233aab0f9ea7647d5cca9726113cc1768de61d66b17267f4db84488f6'
ESBUILD_SHA256_arm64='a96dbfa41d3ef5dbd1ef22b1c10d5187be9267e86093a870f06402a7ec931596'

# Where a node keeps its identity, and how. Both are the repository's own rule:
# the Ed25519 pair that speaks for this node is written 0600 into a directory
# created 0700, and a node that lost it would register a fresh id and leave a
# stale public key behind in the registry.
STATE_DIR='/var/lib/scafo'
STATE_DIR_MODE='0700'
CONFIG_DIR='/etc/scafo'
INGRESS_LOG_DIR='/var/log/scafo-ingress'
SERVICE_USER='scafo'
CADDY_USER='caddy'
# Where the ingress keeps its certificates and its ACME account. It is also what
# `StateDirectory=caddy` in the unit below resolves to, so the two must agree.
# scafo-caddy keeps its TLS material in the BUCKET instead and leaves this
# directory nearly empty; the unit sets it either way, because which flavour is
# running must not change where a stray file lands.
CADDY_STATE_DIR='/var/lib/caddy'

# The token the ingress presents to the node's /v1/storage, and it is ONE name
# in three places that must agree: the file the node mints in the state
# directory, the systemd credential the ingress unit loads it as, and the
# `token_file` the ingress config points at inside $CREDENTIALS_DIRECTORY. One
# constant so they cannot drift apart.
STORAGE_TOKEN_NAME='storage-token'
# Where the ingress reaches the node's storage API. This host's loopback, and it
# must agree with SCAFO_LISTEN in the node.env written below: they are the two
# ends of the same socket.
STORAGE_ENDPOINT='http://127.0.0.1:7400'

# The stop grace is part of the product, not a tuning preference: on SIGTERM the
# agent marks itself draining, releases the coordinator lease, stops
# reconciling, closes its listener and only THEN stops the runtime processes,
# each of which drains its in-flight requests for 25s and is killed at 30s.
# Anything under 35 cuts that off mid-drain.
STOP_TIMEOUT='40'

DEFAULT_INSTALL_BASE_LATEST='https://github.com/sandros94/scafo/releases/latest/download'
DEFAULT_INSTALL_BASE_TAGGED='https://github.com/sandros94/scafo/releases/download'
DEFAULT_CADDY_BASE='https://github.com/sandros94/scafo-certmagic/releases/latest/download'

# ---------------------------------------------------------------------------

main() {
  # What this particular run made, for the manifest at the end of it.
  INSTALLED_BINARIES=''
  CREATED_USERS=''

  need_cmd uname
  need_cmd mktemp
  need_cmd install
  need_cmd sha256sum
  need_cmd tar
  need_cmd gzip
  detect_downloader

  detect_platform
  resolve_caddy_flavor
  resolve_destination

  say "installing into ${BIN_DIR} for ${OS}-${ARCH}"
  say "ingress: ${CADDY_FLAVOR_LABEL}"

  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT INT TERM

  # EVERYTHING IS FETCHED AND VERIFIED BEFORE ANYTHING IS INSTALLED. A run that
  # gave up halfway would leave a host carrying a new scafo and the old celld
  # beside it — two versions that were never tested together, and no note
  # anywhere saying so. Four checksums pass, or nothing on this host changes.
  fetch_scafo
  fetch_celld
  fetch_caddy
  fetch_esbuild

  install_binary "${WORK}/scafo" 'scafo'
  install_binary "${WORK}/celld" 'celld'
  install_binary "${WORK}/caddy" 'caddy'
  install_binary "${WORK}/package/bin/esbuild" 'esbuild'

  if want_units; then
    create_users
    write_config
    write_units
    write_manifest
    UNITS_WRITTEN='yes'
  else
    UNITS_WRITTEN='no'
    explain_manual_setup
  fi

  next_steps
}

# ---------------------------------------------------------------------------
# Platform

detect_platform() {
  OS="$(uname -s)"
  if [ "$OS" != 'Linux' ]; then
    die "scafo runs on Linux; this host reports \"${OS}\". The CLI half of the
  binary can be built for macOS with \`pnpm compile\`, but a NODE supervises
  cgroup-limited processes and drives an ingress, which is a Linux host."
  fi
  OS='linux'

  machine="$(uname -m)"
  case "$machine" in
    x86_64 | amd64) ARCH='amd64' ;;
    aarch64 | arm64) ARCH='arm64' ;;
    *)
      die "no scafo build exists for \"${machine}\"; supported: x86_64, aarch64"
      ;;
  esac

  # Every binary installed here is dynamically linked against glibc. On musl they
  # fail at exec with a message about a missing loader, which is a far worse
  # thing to find out than this.
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
    die "this host's C library is musl (Alpine or similar), and every binary
  installed here — scafo, celld, caddy — is linked against glibc. Run the node
  from the container image instead: ghcr.io/sandros94/scafo, or \`docker build\`
  from the repository."
  fi
}

# Which of the two Caddys this run installs, decided BEFORE anything is fetched
# or any directory is made, so a typo costs a message rather than a download. It
# is one variable from here on: the binary is installed as `caddy` either way,
# and only fetch_caddy(), the `storage` block and two lines of the ingress unit
# read it.
resolve_caddy_flavor() {
  case "${SCAFO_INSTALL_CADDY:-scafo}" in
    scafo)
      CADDY_FLAVOR='scafo'
      CADDY_FLAVOR_LABEL='scafo-caddy (caddy.storage.scafo — TLS material in the bucket)'
      ;;
    plain)
      CADDY_FLAVOR='plain'
      CADDY_FLAVOR_LABEL="upstream Caddy ${CADDY_VERSION} (certificates on this host)"
      ;;
    *)
      die "SCAFO_INSTALL_CADDY is \"${SCAFO_INSTALL_CADDY}\", and it is one of two words:
  scafo   the default — Caddy built with the caddy.storage.scafo module, which
          keeps this node's TLS material in the bucket through /v1/storage
  plain   upstream Caddy, pinned in this script, certificates on this host"
      ;;
  esac
}

detect_downloader() {
  if command -v curl >/dev/null 2>&1; then
    DOWNLOADER='curl'
  elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER='wget'
  else
    die 'neither curl nor wget is installed; one of them is needed to download anything'
  fi
}

# Decides where the executables go, and whether this run may write to it.
#
# Three cases, in order: an explicit SCAFO_INSTALL_BIN_DIR, root or passwordless
# sudo (which get /usr/local/bin), and everyone else (who gets ~/.local/bin and
# is told about PATH at the end). Passwordless is the only sudo worth testing
# for: this script is meant to be readable from a pipe, and a pipe has no
# terminal for a password prompt.
resolve_destination() {
  SUDO=''
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
      SUDO='sudo'
    fi
  fi

  if [ -n "${SCAFO_INSTALL_BIN_DIR:-}" ]; then
    BIN_DIR="$SCAFO_INSTALL_BIN_DIR"
  elif [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; then
    BIN_DIR='/usr/local/bin'
  else
    BIN_DIR="${HOME}/.local/bin"
    SUDO=''
  fi

  as_root mkdir -p "$BIN_DIR"
}

# Runs a command with whatever privilege this install has. Never elevates on its
# own: with no sudo, `as_root` is the caller's own user and a write it may not do
# fails loudly instead of half-succeeding.
as_root() {
  if [ -n "$SUDO" ]; then
    $SUDO "$@"
  else
    "$@"
  fi
}

want_units() {
  [ "${SCAFO_INSTALL_SKIP_UNITS:-0}" != '1' ] || return 1
  [ "$(id -u)" -eq 0 ] || return 1
  [ -d /run/systemd/system ] || return 1
  command -v systemctl >/dev/null 2>&1 || return 1
}

# ---------------------------------------------------------------------------
# Downloads

# The third argument is for the one download whose failure is EXPECTED to happen
# to somebody: a "latest" release that does not exist yet 404s, and "could not
# download" would leave the reader with no idea that there is a way forward.
download() {
  # download <url> <destination> [what to say when it fails]
  download_msg="${3:-could not download ${1}}"
  if [ "$DOWNLOADER" = 'curl' ]; then
    curl -fsSL -o "$2" "$1" || die "$download_msg"
  else
    wget -qO "$2" "$1" || die "$download_msg"
  fi
}

download_text() {
  # download_text <url>; prints the body, or nothing when it is not there
  if [ "$DOWNLOADER" = 'curl' ]; then
    curl -fsSL "$1" 2>/dev/null || true
  else
    wget -qO- "$1" 2>/dev/null || true
  fi
}

# Refuses anything whose bytes are not the ones expected. Everything downloaded
# here goes through this before it is unpacked, made executable or moved: an
# installer that verified only some of what it installs verifies nothing.
verify() {
  # verify <file> <expected sha256> <what>
  verify_actual="$(sha256sum "$1" | cut -d' ' -f1)"
  if [ "$verify_actual" != "$2" ]; then
    die "checksum mismatch for ${3}
  expected ${2}
  got      ${verify_actual}
  Nothing on this host was changed — every download is verified before any of
  them is installed. Either the download was corrupted, the pin is stale, or
  something is serving different bytes than it should."
  fi
  say "verified ${3} (${2})"
}

install_binary() {
  # install_binary <source file> <name>
  as_root install -m 0755 "$1" "${BIN_DIR}/$2"
  INSTALLED_BINARIES="${INSTALLED_BINARIES} $2"
  say "installed ${BIN_DIR}/$2"
}

# Where a third-party artifact is fetched from: its upstream, or the same file
# name under SCAFO_INSTALL_MIRROR. The checksum is pinned either way, which is
# what makes a mirror safe to point at.
artifact_url() {
  # artifact_url <upstream url> <file name>
  if [ -n "${SCAFO_INSTALL_MIRROR:-}" ]; then
    printf '%s/%s\n' "${SCAFO_INSTALL_MIRROR%/}" "$2"
  else
    printf '%s\n' "$1"
  fi
}

fetch_scafo() {
  version="${SCAFO_VERSION:-latest}"
  if [ -n "${SCAFO_INSTALL_BASE:-}" ]; then
    base="$SCAFO_INSTALL_BASE"
  elif [ "$version" = 'latest' ]; then
    base="$DEFAULT_INSTALL_BASE_LATEST"
  else
    base="${DEFAULT_INSTALL_BASE_TAGGED}/v${version}"
  fi

  name="scafo-${OS}-${ARCH}"
  download "${base}/${name}" "${WORK}/scafo"

  # The checksum is the operator's to pin. SCAFO_SHA256 wins; failing that the
  # `.sha256` `pnpm compile` writes beside the binary is fetched, which catches a
  # truncated or corrupted download but proves nothing about provenance —
  # whoever served one served the other. It is said out loud at the end.
  if [ -n "${SCAFO_SHA256:-}" ]; then
    expected="$SCAFO_SHA256"
    SCAFO_CHECKSUM_SOURCE='pinned by SCAFO_SHA256'
  else
    expected="$(download_text "${base}/${name}.sha256" | cut -d' ' -f1)"
    SCAFO_CHECKSUM_SOURCE="taken from ${name}.sha256 beside the download"
    [ -n "$expected" ] || die "no checksum for ${name}: nothing at ${base}/${name}.sha256,
  and SCAFO_SHA256 was not set. Refusing to install an unverified binary."
  fi

  verify "${WORK}/scafo" "$expected" "$name"
}

fetch_celld() {
  triple="x86_64-unknown-linux-gnu"
  expected="$CELLD_SHA256_amd64"
  if [ "$ARCH" = 'arm64' ]; then
    triple='aarch64-unknown-linux-gnu'
    expected="$CELLD_SHA256_arm64"
  fi

  name="celld-${triple}.gz"
  download "$(artifact_url \
    "https://github.com/denoland/celld/releases/download/v${CELLD_VERSION}/${name}" "$name")" \
    "${WORK}/celld.gz"
  verify "${WORK}/celld.gz" "$expected" "celld ${CELLD_VERSION} (${triple})"

  gzip -dc "${WORK}/celld.gz" > "${WORK}/celld"
}

# Whichever flavour was chosen, the result is ${WORK}/caddy and the caller does
# not care which one it is.
fetch_caddy() {
  if [ "$CADDY_FLAVOR" = 'plain' ]; then
    fetch_caddy_plain
  else
    fetch_caddy_scafo
  fi
}

# The DEFAULT. A plain binary out of the scafo-certmagic repository's latest
# release, held to the .sha256 beside it or to SCAFO_CADDY_SHA256 — the same
# integrity-by-default, authenticity-by-pin posture the scafo binary has, and
# for the same reason: a URL that always means "the newest one" cannot be given
# a checksum in this file that stays true past the next release.
fetch_caddy_scafo() {
  base="${SCAFO_CADDY_BASE:-$DEFAULT_CADDY_BASE}"
  name="scafo-caddy-${OS}-${ARCH}"

  download "${base}/${name}" "${WORK}/caddy" \
    "could not download ${base}/${name}

  That is scafo-caddy — Caddy built with the caddy.storage.scafo module — and it
  is what this script installs by DEFAULT, because it is what lets every node in
  a fleet serve one certificate out of the bucket instead of issuing its own.
  Either there is no release to fetch yet, or this host cannot reach it.

  UNTIL THERE IS ONE, INSTALL THE PLAIN CADDY INSTEAD:

    SCAFO_INSTALL_CADDY=plain sh install.sh

  which is upstream Caddy, pinned and verified in this script, keeping its
  certificates on this host — per-node TLS, which is correct for one host and is
  a rate limit waiting to happen on a fleet. Moving to scafo-caddy later is a
  re-run of this script with /etc/scafo/caddy.json moved out of the way.

  Or point SCAFO_CADDY_BASE at your own \`xcaddy build --with
  github.com/sandros94/scafo-certmagic\` output, named ${name},
  with a ${name}.sha256 beside it or SCAFO_CADDY_SHA256 set."

  if [ -n "${SCAFO_CADDY_SHA256:-}" ]; then
    expected="$SCAFO_CADDY_SHA256"
    CADDY_CHECKSUM_SOURCE='pinned by SCAFO_CADDY_SHA256'
  else
    expected="$(download_text "${base}/${name}.sha256" | cut -d' ' -f1)"
    CADDY_CHECKSUM_SOURCE="taken from ${name}.sha256 beside the download"
    [ -n "$expected" ] || die "no checksum for ${name}: nothing at ${base}/${name}.sha256,
  and SCAFO_CADDY_SHA256 was not set. Refusing to install an unverified binary."
  fi

  verify "${WORK}/caddy" "$expected" "$name"
}

# The opt-down: SCAFO_INSTALL_CADDY=plain. Pinned by version and checksum above,
# fetchable through SCAFO_INSTALL_MIRROR because a pin is what makes a mirror
# safe to point at.
fetch_caddy_plain() {
  expected="$CADDY_SHA256_amd64"
  [ "$ARCH" = 'arm64' ] && expected="$CADDY_SHA256_arm64"

  name="caddy_${CADDY_VERSION}_linux_${ARCH}.tar.gz"
  download "$(artifact_url \
    "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${name}" "$name")" \
    "${WORK}/caddy.tar.gz"
  verify "${WORK}/caddy.tar.gz" "$expected" "caddy ${CADDY_VERSION} (${ARCH})"

  tar -xzf "${WORK}/caddy.tar.gz" -C "$WORK" caddy
  CADDY_CHECKSUM_SOURCE="pinned in this script (caddy ${CADDY_VERSION})"
}

# esbuild is not optional and it is not a scafo dependency in the usual sense:
# `celld deploy` bundles every artifact with it, so a node without one accepts
# deploys and then fails every single one of them. It ships only as a per-platform
# npm package, which is why this is a registry tarball rather than a release
# asset — the file inside it is a plain native executable.
fetch_esbuild() {
  expected="$ESBUILD_SHA256_amd64"
  npm_arch='x64'
  if [ "$ARCH" = 'arm64' ]; then
    expected="$ESBUILD_SHA256_arm64"
    npm_arch='arm64'
  fi

  name="linux-${npm_arch}-${ESBUILD_VERSION}.tgz"
  download "$(artifact_url \
    "https://registry.npmjs.org/@esbuild/linux-${npm_arch}/-/${name}" "$name")" \
    "${WORK}/esbuild.tgz"
  verify "${WORK}/esbuild.tgz" "$expected" "esbuild ${ESBUILD_VERSION} (${ARCH})"

  tar -xzf "${WORK}/esbuild.tgz" -C "$WORK" package/bin/esbuild
}

# ---------------------------------------------------------------------------
# The host

create_users() {
  # System accounts, because neither of these ever logs in. The node's is what
  # owns its identity; Caddy's is what owns its certificates.
  #
  # WHICH OF THEM THIS RUN CREATED IS RECORDED, and it is the one fact the
  # uninstall cannot work out for itself: a "caddy" account a distribution's own
  # package made owns a Caddy neither script knows anything about, and deleting
  # it would be a far worse mistake than leaving an unused account behind.
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" \
      || die "could not create the \"${SERVICE_USER}\" system user"
    CREATED_USERS="${CREATED_USERS} ${SERVICE_USER}"
    say "created system user ${SERVICE_USER}"
  fi
  if ! id "$CADDY_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$CADDY_STATE_DIR" --shell /usr/sbin/nologin "$CADDY_USER" \
      || die "could not create the \"${CADDY_USER}\" system user"
    CREATED_USERS="${CREATED_USERS} ${CADDY_USER}"
    say "created system user ${CADDY_USER}"
  fi

  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m "$STATE_DIR_MODE" "$STATE_DIR"
  say "state directory ${STATE_DIR} (${STATE_DIR_MODE}, ${SERVICE_USER})"
}

write_config() {
  install -d -m 0755 "$CONFIG_DIR"

  # Written once and never overwritten: this is where an operator's bucket
  # credentials live, and a second run of the installer must not take them away.
  if [ -f "${CONFIG_DIR}/node.env" ]; then
    say "keeping ${CONFIG_DIR}/node.env"
  else
    cat > "${CONFIG_DIR}/node.env" <<EOF
# Configuration of this scafo node, read by scafo-node.service.
#
# The bucket is the whole registry: every node pointed at the SAME bucket and
# prefix is one installation, and nothing else makes two nodes a fleet.
# Required — the node refuses to boot without them.
SCAFO_S3_ENDPOINT=
SCAFO_S3_BUCKET=
SCAFO_S3_ACCESS_KEY=
SCAFO_S3_SECRET_KEY=
SCAFO_S3_REGION=us-east-1
# Optional: keeps this installation inside one prefix of a shared bucket.
#SCAFO_S3_PREFIX=

# The names applications are served under: <project>.<domain>,
# <project>--<env>.<domain>, <project>--<build>.<domain>. Comma-separated.
SCAFO_PLATFORM_DOMAINS=

# The agent API. Loopback needs no further statement about the network; widening
# it makes the node refuse to boot until SCAFO_TRANSPORT says what that network
# is — "wireguard" to tunnel it, "none" to state that it is already private.
SCAFO_LISTEN=127.0.0.1:7400
#SCAFO_ADVERTISE=
#SCAFO_TRANSPORT=

# Caddy's admin API, on this host's loopback. This is how the node converges the
# routing; it owns only the routes it created inside the "scafo" server.
SCAFO_CADDY_ADMIN=http://127.0.0.1:2019

# What this machine IS, for environments that ask for a class of node.
#SCAFO_NODE_LABELS=tier=fast,region=eu-west-1

# Observing this node: the first switch makes it record its own events, and the
# second — which is REFUSED without the first — counts what Caddy actually
# served. Read both back with "scafo metrics" and "scafo traces".
#SCAFO_OBSERVABILITY=1
#SCAFO_INGRESS_ACCESS_LOG=${INGRESS_LOG_DIR}/access.log
EOF
    chmod 0600 "${CONFIG_DIR}/node.env"
    say "wrote ${CONFIG_DIR}/node.env (0600 — it will hold the bucket secret)"
  fi

  if [ -f "${CONFIG_DIR}/caddy.json" ]; then
    # Never overwritten, which is also what makes changing flavour a deliberate
    # act: a re-run with SCAFO_INSTALL_CADDY=plain over a scafo-caddy install
    # would otherwise leave a `storage` block a plain Caddy cannot load, and the
    # reverse would leave a scafo-caddy storing certificates on local disk.
    say "keeping ${CONFIG_DIR}/caddy.json"
    if ! caddy_json_matches_flavor; then
      warn "${CONFIG_DIR}/caddy.json was written for the OTHER ingress flavour;
  move it aside and re-run this script to have the matching one written"
    fi
  else
    render_caddy_json > "${CONFIG_DIR}/caddy.json"
    chmod 0644 "${CONFIG_DIR}/caddy.json"
    say "wrote ${CONFIG_DIR}/caddy.json"
  fi
}

# Whether the file already on this host is the one this run's flavour needs. The
# `storage` block is the whole difference, so its presence is the whole test.
caddy_json_matches_flavor() {
  if grep -q '"module": "scafo"' "${CONFIG_DIR}/caddy.json" 2>/dev/null; then
    [ "$CADDY_FLAVOR" = 'scafo' ]
  else
    [ "$CADDY_FLAVOR" = 'plain' ]
  fi
}

# The ingress config, printed rather than written so that what goes on a host
# and what a test reads are the same bytes.
#
# The one thing this file must have is a server the node may write into: the
# driver adds and removes routes carrying its own "scafo_" @id prefix inside it
# and touches nothing else, so an operator's own routes can live in the same
# array and survive every reconcile pass.
#
# The access log is written here because it costs nothing while
# SCAFO_INGRESS_ACCESS_LOG stays commented out, and turning counting on later is
# then one line in node.env rather than a Caddy restart. "mode": "0644" is what
# lets the node, running as another user, read what Caddy writes as its own.
render_caddy_json() {
  cat <<EOF
{
  "admin": {
    "listen": "127.0.0.1:2019"
  },
EOF

  # THE ONLY DIFFERENCE BETWEEN THE TWO FLAVOURS, and the reason the token_file
  # is not the path the node actually mints: that file is 0600 `scafo` inside a
  # 0700 directory and the `caddy` account cannot open it. The unit loads it as
  # a systemd credential — read by the service manager as root, copied read-only
  # into a directory only this service's UID may enter — and this is where that
  # copy lands. The module resolves {env....} itself: its Provision() runs
  # Caddy's ReplaceKnown over both fields before it reads the file.
  [ "$CADDY_FLAVOR" != 'scafo' ] || cat <<EOF
  "storage": {
    "module": "scafo",
    "endpoint": "${STORAGE_ENDPOINT}",
    "token_file": "{env.CREDENTIALS_DIRECTORY}/${STORAGE_TOKEN_NAME}"
  },
EOF

  cat <<EOF
  "logging": {
    "logs": {
      "default": { "exclude": ["http.log.access.scafo"] },
      "scafo": {
        "writer": {
          "output": "file",
          "filename": "${INGRESS_LOG_DIR}/access.log",
          "mode": "0644"
        },
        "encoder": { "format": "json" },
        "include": ["http.log.access.scafo"]
      }
    }
  },
  "apps": {
    "http": {
      "servers": {
        "scafo": {
          "listen": [":80", ":443"],
          "routes": [],
          "logs": { "default_logger_name": "scafo" }
        }
      }
    }
  }
}
EOF
}

write_units() {
  render_node_unit > /etc/systemd/system/scafo-node.service
  render_ingress_unit > "/etc/systemd/system/${CADDY_USER}.service"

  say 'wrote /etc/systemd/system/scafo-node.service'
  say "wrote /etc/systemd/system/${CADDY_USER}.service"
  # The files are the deliverable; the reload is a convenience. Failing the whole
  # install because it did not run would leave a host that is correctly set up
  # and told it is not.
  if systemctl daemon-reload 2>/dev/null; then
    say 'ran systemctl daemon-reload'
  else
    warn 'the units are written but "systemctl daemon-reload" did not run; run it yourself'
  fi
}

# THE ORDER IS THE POINT. scafo-caddy stores its TLS material through the node:
# it reads the node's /v1/storage and the storage token the node MINTS ON ITS
# FIRST BOOT. Started first, it finds neither. Plain Caddy does not care, and
# the ordering is written for it anyway so that changing flavour changes nothing
# here.
render_node_unit() {
  cat <<EOF
[Unit]
Description=scafo node agent
Documentation=https://github.com/sandros94/scafo
Wants=network-online.target
After=network-online.target
# Pulled in and started BEFORE the ingress; see the comment in the installer.
Wants=${CADDY_USER}.service
Before=${CADDY_USER}.service

[Service]
Type=exec
User=${SERVICE_USER}
Group=${SERVICE_USER}
EnvironmentFile=${CONFIG_DIR}/node.env
Environment=SCAFO_STATE_DIR=${STATE_DIR}
# Pinned rather than resolved: the node hands this path to "celld deploy" for
# every build, and which esbuild builds a customer's code must not depend on
# what happens to be on PATH.
Environment=ESBUILD_BINARY_PATH=${BIN_DIR}/esbuild
Environment=SCAFO_CELLD_BIN=${BIN_DIR}/celld
ExecStart=${BIN_DIR}/scafo sail
Restart=on-failure
RestartSec=5s

# KillMode=mixed, and it is load-bearing: systemd's default signals every
# process in the cgroup at once, which would SIGTERM the runtime processes
# beside the agent instead of letting the agent stop them in its own order —
# mark draining, release the lease, stop reconciling, close the listener, and
# only then drain each runtime. "mixed" signals the agent alone, exactly as a
# container runtime signals PID 1.
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=${STOP_TIMEOUT}s

StateDirectory=scafo
StateDirectoryMode=${STATE_DIR_MODE}
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
}

render_ingress_unit() {
  cat <<EOF
[Unit]
Description=Caddy, the ingress a scafo node routes through
Documentation=https://caddyserver.com/docs/
Wants=network-online.target
After=network-online.target scafo-node.service
EOF

  # THE FIRST BOOT IS A RACE THIS UNIT LOSES, ON PURPOSE, AND COMES BACK FROM.
  #
  # After= only says the node's process was exec'd. The token appears a moment
  # later, once the node has reached its bucket and registered itself — so on a
  # host's first boot this service starts before there is anything to load. A
  # LoadCredential= whose source does not exist is FATAL: the service manager
  # fails the start at status 243/CREDENTIALS before ANY of this unit's own
  # commands runs, which is exactly why a wait loop in ExecStartPre cannot help
  # — that command would be the one failing. (Verified against systemd 255:
  # "Failed to set up credentials: No such file or directory", control process
  # exited 243/CREDENTIALS, and the ExecStartPre never ran.)
  #
  # What works is letting it fail and come straight back. Restart=on-failure
  # below already covers that status, and StartLimitIntervalSec=0 turns off the
  # rate limiter that would otherwise stop retrying after five starts and leave
  # the ingress failed for good over a gap that lasts seconds. So this unit
  # fails a few times in the first moments of a host's life, says why each time,
  # and starts the moment the token is there.
  #
  # It also means a node that never boots leaves the ingress retrying rather
  # than failed, which is the honest state to be in: without the node there is
  # no storage, and without storage this Caddy has no certificates to serve.
  #
  # Requires=scafo-node.service is deliberately NOT set. A RUNNING Caddy is
  # unaffected by the node stopping — its certificates are in memory — and
  # binding the two would take TLS down for every restart of the node.
  [ "$CADDY_FLAVOR" != 'scafo' ] || cat <<EOF
StartLimitIntervalSec=0
EOF

  cat <<EOF

[Service]
Type=notify
User=${CADDY_USER}
Group=${CADDY_USER}
EOF

  # THE TOKEN, AND WHY IT IS NOT SIMPLY A PATH.
  #
  # The node mints the storage token 0600, owned by the account it runs as,
  # inside a 0700 directory — and this service runs as another account, which
  # can open neither. That is not an oversight to fix by widening a mode: the
  # storage API that token opens carries private keys in both directions.
  # systemd carries it across instead. LoadCredential= has THE SERVICE MANAGER
  # read the file, as root, before this service has a process at all, and place
  # a read-only copy in $CREDENTIALS_DIRECTORY — a directory only this unit's own
  # UID and root may enter (verified on systemd 255: the copy lands r--------,
  # owned by the service user). caddy.json's token_file points at that copy, and
  # the module resolves the {env....} placeholder itself in its Provision().
  # Nothing about the source file's ownership or mode changes.
  [ "$CADDY_FLAVOR" != 'scafo' ] || cat <<EOF
LoadCredential=${STORAGE_TOKEN_NAME}:${STATE_DIR}/${STORAGE_TOKEN_NAME}
EOF

  cat <<EOF
ExecStart=${BIN_DIR}/caddy run --config ${CONFIG_DIR}/caddy.json
ExecReload=${BIN_DIR}/caddy reload --config ${CONFIG_DIR}/caddy.json --force
Restart=on-failure
RestartSec=5s
TimeoutStopSec=5s

# Caddy's own state directory. With scafo-caddy the certificates and the ACME
# account are NOT here — they are in the bucket, reached through the node — and
# this holds little more than scratch; with plain Caddy it holds all of it, on
# this host's disk, which is the per-node TLS the installer's header describes.
# Set either way, so that changing flavour never leaves a file with nowhere to
# land.
StateDirectory=caddy
Environment=XDG_DATA_HOME=${CADDY_STATE_DIR}
Environment=XDG_CONFIG_HOME=${CADDY_STATE_DIR}
# What the node counts requests out of, when it is told to.
LogsDirectory=scafo-ingress
LogsDirectoryMode=0755

# Binding 80 and 443 without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
}

# The record of what this run made, written where the node's own state lives —
# and read by scripts/uninstall.sh, which removes exactly what is in it.
#
# Two of these lines cannot be derived from anywhere else on the host: which
# directory the executables went into when SCAFO_INSTALL_BIN_DIR moved them, and
# which of the two system accounts this run CREATED rather than found. The rest
# is written down for the same reason a receipt lists what is already obvious —
# so that changing the installer changes what the uninstall is told, rather than
# leaving the two to agree by memory.
#
# IT IS NOT A DEPENDENCY. The uninstall falls back to these same constants, to
# the ExecStart of the unit below, and to whatever `scafo` is on PATH, so a host
# installed before this file existed — or one whose state directory has already
# been purged — comes apart just as cleanly, only more carefully. Written here
# rather than under /etc because it describes THIS host's install and belongs
# beside the identity that install has; a run that writes no units writes no
# manifest either, having made no directory of its own to keep one in.
write_manifest() {
  manifest="${STATE_DIR}/install.manifest"
  # A reinstall over kept state finds the accounts already existing and creates
  # none — but the FACT that an earlier run created them must outlive that run,
  # or the rewrite below erases it and a later --purge leaves both accounts
  # behind while reporting it kept nothing. Prior created_user lines are folded
  # back in before the file is replaced.
  if [ -f "$manifest" ]; then
    while IFS= read -r prior_line; do
      case "$prior_line" in
        created_user=*)
          prior_user="${prior_line#created_user=}"
          case " ${CREATED_USERS} " in
            *" ${prior_user} "*) ;;
            *) CREATED_USERS="${CREATED_USERS} ${prior_user}" ;;
          esac
          ;;
      esac
    done <"$manifest"
  fi
  {
    printf '# What scripts/install.sh made on this host, for scripts/uninstall.sh.\n'
    printf '# Losing this file does not break the uninstall; it only makes it derive.\n'
    printf 'manifest_version=1\n'
    printf 'installed_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo 'unknown')"
    printf 'bin_dir=%s\n' "$BIN_DIR"
    for name in $INSTALLED_BINARIES; do printf 'binary=%s\n' "$name"; done
    printf 'unit=/etc/systemd/system/scafo-node.service\n'
    printf 'unit=/etc/systemd/system/%s.service\n' "$CADDY_USER"
    printf 'config_dir=%s\n' "$CONFIG_DIR"
    printf 'state_dir=%s\n' "$STATE_DIR"
    printf 'ingress_log_dir=%s\n' "$INGRESS_LOG_DIR"
    printf 'caddy_state_dir=%s\n' "$CADDY_STATE_DIR"
    printf 'service_user=%s\n' "$SERVICE_USER"
    printf 'caddy_user=%s\n' "$CADDY_USER"
    # Which of the two Caddys the `caddy` in bin_dir actually is. The uninstall
    # removes the same file either way — that is the whole reason both are
    # installed under one name — so this is for its REPORT, and for anyone
    # reading the host afterwards to know whether the certificates it served
    # were this host's or the bucket's.
    printf 'caddy_flavor=%s\n' "$CADDY_FLAVOR"
    for name in $CREATED_USERS; do printf 'created_user=%s\n' "$name"; done
  } > "$manifest"
  chmod 0644 "$manifest"
  chown "${SERVICE_USER}:${SERVICE_USER}" "$manifest" 2>/dev/null || true
  say "wrote ${manifest}"
}

explain_manual_setup() {
  say ''
  if [ "${SCAFO_INSTALL_SKIP_UNITS:-0}" = '1' ]; then
    say 'no systemd units written (SCAFO_INSTALL_SKIP_UNITS=1).'
  elif [ "$(id -u)" -ne 0 ]; then
    say 'no systemd units written: this ran as a normal user, and units are root-owned files.'
  else
    say 'no systemd units written: systemd is not running on this host.'
  fi
  say 'Run the two processes yourself, IN THIS ORDER — the ingress may need the'
  say 'storage token the node mints on its first boot:'
  say ''
  say "  install -d -m ${STATE_DIR_MODE} ${STATE_DIR}"
  say "  SCAFO_STATE_DIR=${STATE_DIR} \\"
  say "  ESBUILD_BINARY_PATH=${BIN_DIR}/esbuild SCAFO_CELLD_BIN=${BIN_DIR}/celld \\"
  say "  SCAFO_S3_ENDPOINT=... SCAFO_S3_BUCKET=... SCAFO_S3_ACCESS_KEY=... \\"
  say "  SCAFO_S3_SECRET_KEY=... SCAFO_PLATFORM_DOMAINS=... \\"
  say "  SCAFO_CADDY_ADMIN=http://127.0.0.1:2019 \\"
  say "    ${BIN_DIR}/scafo sail --listen 127.0.0.1:7400"
  say ''
  say "  ${BIN_DIR}/caddy run --config ./caddy.json"
  say ''
  if [ "$CADDY_FLAVOR" = 'scafo' ]; then
    # No unit means no systemd credential, so the config this host would need is
    # NOT the one write_config() writes: token_file has to name the real file,
    # and whoever runs the ingress has to be able to open a 0600 file owned by
    # the account that runs the node. Saying so is the whole point — the
    # alternative is a caddy that fails at startup with a permissions error and
    # an operator with no idea it was ever going to.
    say 'THAT CADDY IS scafo-caddy, and it needs a "storage" block naming the'
    say 'node — write ./caddy.json with:'
    say ''
    say '  "storage": {'
    say '    "module": "scafo",'
    say "    \"endpoint\": \"${STORAGE_ENDPOINT}\","
    say "    \"token_file\": \"${STATE_DIR}/${STORAGE_TOKEN_NAME}\""
    say '  },'
    say ''
    say 'The token is minted 0600 by whoever runs the node. Under systemd this'
    say 'script hands it over with LoadCredential= and nothing is loosened;'
    say 'running both by hand, the ingress must be a user that can read it —'
    say 'the same user as the node, or a group you give it yourself.'
    say ''
  fi
  say 'Whatever supervises them must give the node AT LEAST 35 SECONDS between'
  say 'SIGTERM and SIGKILL, and must signal the agent alone rather than every'
  say 'process beside it: it drains its runtimes itself, in an order that matters.'
}

next_steps() {
  printf '\n'
  printf 'scafo is installed.\n\n'
  printf '  %s/scafo    %s\n' "$BIN_DIR" "$(scafo_version)"
  printf '  %s/celld    %s\n' "$BIN_DIR" "$CELLD_VERSION"
  printf '  %s/caddy    %s\n' "$BIN_DIR" "$(caddy_label)"
  printf '  %s/esbuild  %s\n' "$BIN_DIR" "$ESBUILD_VERSION"
  printf '\n'
  printf 'The scafo binary was %s.\n' "$SCAFO_CHECKSUM_SOURCE"
  if [ "$CADDY_FLAVOR" = 'scafo' ]; then
    printf 'The scafo-caddy binary was %s.\n' "$CADDY_CHECKSUM_SOURCE"
  fi

  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *)
      printf '\n'
      printf '%s IS NOT ON YOUR PATH. Add it:\n\n' "$BIN_DIR"
      # shellcheck disable=SC2016 # the "$PATH" is printed for the reader to run
      printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
      ;;
  esac

  printf '\nNEXT\n\n'
  if [ "$UNITS_WRITTEN" = 'yes' ]; then
    printf '1. Give the node a bucket. It is the whole registry, and nothing starts\n'
    printf '   without one:\n\n'
    printf '     sudoedit %s/node.env\n\n' "$CONFIG_DIR"
    printf '   SCAFO_S3_ENDPOINT, SCAFO_S3_BUCKET, SCAFO_S3_ACCESS_KEY,\n'
    printf '   SCAFO_S3_SECRET_KEY and SCAFO_PLATFORM_DOMAINS are the required five.\n\n'
    printf '2. Start it, and the ingress with it:\n\n'
    printf '     systemctl enable --now scafo-node.service\n'
    printf '     systemctl status scafo-node.service %s.service\n\n' "$CADDY_USER"
    printf '3. Mint an operator key. It signs everything you ask a node to do, and\n'
    printf '   it reads the SAME bucket settings — export them into your shell first:\n\n'
    printf '     scafo operator keygen --register\n\n'
    printf '   The key lands in ./scafo-operator.json, which is where "scafo deploy"\n'
    printf '   looks for it. Back it up: nothing can reissue it.\n\n'
    printf '4. Deploy something:\n\n'
    printf '     scafo deploy ./my-app --agent http://127.0.0.1:7400 \\\n'
    printf '       --project shop --env production --flip\n\n'
  else
    printf '1. Run the node and the ingress as described above.\n'
    printf '2. Mint an operator key with the same bucket settings exported:\n\n'
    printf '     scafo operator keygen --register\n\n'
    printf '3. Deploy something:\n\n'
    printf '     scafo deploy ./my-app --agent http://127.0.0.1:7400 \\\n'
    printf '       --project shop --env production --flip\n\n'
  fi

  printf 'WHERE THINGS ARE\n\n'
  printf '  %-32s node identity, 0600 in a %s directory\n' "${STATE_DIR}/node.json" "$STATE_DIR_MODE"
  printf '  %-32s the token the ingress presents to /v1/storage,\n' "${STATE_DIR}/${STORAGE_TOKEN_NAME}"
  printf '  %-32s minted on the first boot. LOCAL OR TUNNELLED CALLERS ONLY:\n' ''
  printf '  %-32s that surface carries private keys in both directions.\n' ''
  if [ "$CADDY_FLAVOR" = 'scafo' ] && [ "$UNITS_WRITTEN" = 'yes' ]; then
    printf '  %-32s 0600 and left that way: systemd reads it as root\n' ''
    printf '  %-32s (LoadCredential=) and hands the ingress a private copy.\n' ''
  fi
  if [ "$UNITS_WRITTEN" = 'yes' ]; then
    printf '  %-32s bucket credentials and every other setting\n' "${CONFIG_DIR}/node.env"
    printf '  %-32s the ingress config the node writes its routes into\n' "${CONFIG_DIR}/caddy.json"
    printf '  %-32s where Caddy logs what it served, when asked to\n' "${INGRESS_LOG_DIR}/"
    printf '  %-32s what this run installed, for scripts/uninstall.sh\n' "${STATE_DIR}/install.manifest"
  fi

  printf '\nWHAT THIS INSTALL IS NOT\n\n'
  if [ "$CADDY_FLAVOR" = 'scafo' ]; then
    printf '  * THE INGRESS HAS NO BUCKET CREDENTIAL, AND MUST NOT GET ONE. scafo-caddy\n'
    printf '    keeps its certificates, their keys and its ACME account in the bucket by\n'
    printf '    asking THIS NODE for them over %s — a loopback URL\n' "$STORAGE_ENDPOINT"
    printf '    and a bearer token, nothing more. That is the point of it: every node in\n'
    printf '    the fleet serves the one certificate, and the most exposed process on the\n'
    printf '    host still cannot address the bucket.\n'
    if [ "$UNITS_WRITTEN" = 'yes' ]; then
      printf '    ON THE FIRST BOOT THE INGRESS WILL FAIL AND RETRY for as long as it\n'
      printf '    takes the node to mint that token — seconds, normally. It is written to\n'
      printf '    do exactly that (Restart=on-failure with the start rate limit off), so\n'
      printf '    "243/CREDENTIALS" in the first moments of the journal is the design and\n'
      printf '    not a fault. It stops the moment the token is there.\n'
    fi
  else
    printf '  * TLS IS PER-NODE, BY YOUR CHOICE. SCAFO_INSTALL_CADDY=plain installed\n'
    printf '    upstream Caddy, which keeps its certificates on this host, so a second\n'
    printf '    node issues its own for the same names — fine until it is a rate limit.\n'
    printf '    The default here is scafo-caddy, which reads one certificate out of the\n'
    printf '    bucket through this node. Moving to it is a re-run of this script with\n'
    printf '    %s/caddy.json moved aside; nothing else has to be undone.\n' "$CONFIG_DIR"
  fi
  printf '  * NO WIREGUARD. A tunnel needs a kernel module and NET_ADMIN, so it is\n'
  printf '    your package manager'\''s job:\n\n'
  printf '      apt install wireguard-tools   # or dnf, apk, pacman\n\n'
  printf '    Then "scafo wg init" writes wg0.conf and prints the wg-quick command.\n'
  printf '    A single node that never leaves loopback needs none of it.\n'
  printf '  * NOTHING WAS STARTED. See NEXT above.\n\n'
  printf 'UNDOING IT: scripts/uninstall.sh stops and removes all of the above and\n'
  printf 'KEEPS %s, which holds the one thing nothing can reissue —\n' "$STATE_DIR"
  printf 'this node'\''s key pair. "--purge" takes that too, "--dry-run" only says so.\n'
  printf 'Neither touches the bucket: a node that stops is counted out of placement\n'
  printf 'on its own.\n\n'
}

scafo_version() {
  "${BIN_DIR}/scafo" --version 2>/dev/null || echo '(unknown)'
}

# What to call the `caddy` that was just installed. The plain one carries the
# version this script pinned; scafo-caddy came from a "latest" URL and has to be
# asked, because nothing in this file knows which release it was.
caddy_label() {
  if [ "$CADDY_FLAVOR" = 'plain' ]; then
    printf '%s\n' "$CADDY_VERSION"
    return 0
  fi
  caddy_reported="$("${BIN_DIR}/caddy" version 2>/dev/null | head -n 1 | cut -d' ' -f1)"
  printf 'scafo-caddy %s\n' "${caddy_reported:-(unknown)}"
}

# ---------------------------------------------------------------------------

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "\"$1\" is not installed, and this needs it"
}

say() { printf 'scafo: %s\n' "$*" >&2; }

warn() { printf 'scafo: WARNING: %s\n' "$*" >&2; }

die() {
  printf 'scafo: %s\n' "$*" >&2
  exit 1
}

main "$@"
