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
#   caddy    the ingress that terminates TLS and routes to the runtime
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
#   * It installs PLAIN Caddy, which keeps its certificates on this host's disk.
#     That is per-node TLS: correct for one host, and on a fleet it means every
#     node issues its own certificate for the same names. Fleet-shared TLS —
#     every node reading one certificate out of the bucket through the node's
#     own /v1/storage — needs the Caddy built with the `caddy.storage.scafo`
#     module, which is a separate artifact and is not published as a plain
#     binary yet. Nothing here has to be undone to move to it: the same config
#     file gains a `storage` block and the binary is replaced.
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
#   SCAFO_INSTALL_MIRROR   one base URL to fetch celld, Caddy and esbuild from
#                          instead of their upstreams, keeping their file names.
#                          For a host that cannot reach GitHub or npm. IT CANNOT
#                          WEAKEN ANYTHING: the pinned checksums below are still
#                          what every download is held to, so a mirror serving
#                          other bytes is refused exactly as a corrupted
#                          download is.
#   SCAFO_INSTALL_SKIP_UNITS=1   never write systemd units.
#
# Everything else it installs is PINNED — a version and a sha256 per
# architecture, written down below and verified before install. Moving to a new
# celld, Caddy or esbuild is an edit of those constants.

set -eu

# ---------------------------------------------------------------------------
# What is installed, and the bytes it must be.
#
# The checksums were computed from the artifacts these URLs serve. Caddy's own
# `caddy_<v>_checksums.txt` publishes SHA-512; the sha256 below were taken from
# the same files after their SHA-512 matched that list, so verifying either one
# verifies the same bytes.

CELLD_VERSION='0.3.0'
CELLD_SHA256_amd64='cbfcfa5f6d7551b5316f6f4c9d7751c741a9ba2a2305dde8d5cb4d1b37fb34a6'
CELLD_SHA256_arm64='88a35070144408f902036076b7f88df38548ce4dda073fff27a6dd1f6d2bae28'

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

# The stop grace is part of the product, not a tuning preference: on SIGTERM the
# agent marks itself draining, releases the coordinator lease, stops
# reconciling, closes its listener and only THEN stops the runtime processes,
# each of which drains its in-flight requests for 25s and is killed at 30s.
# Anything under 35 cuts that off mid-drain.
STOP_TIMEOUT='40'

DEFAULT_INSTALL_BASE_LATEST='https://github.com/sandros94/scafo/releases/latest/download'
DEFAULT_INSTALL_BASE_TAGGED='https://github.com/sandros94/scafo/releases/download'

# ---------------------------------------------------------------------------

main() {
  need_cmd uname
  need_cmd mktemp
  need_cmd install
  need_cmd sha256sum
  need_cmd tar
  need_cmd gzip
  detect_downloader

  detect_platform
  resolve_destination

  say "installing into ${BIN_DIR} for ${OS}-${ARCH}"

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

download() {
  # download <url> <destination>
  if [ "$DOWNLOADER" = 'curl' ]; then
    curl -fsSL -o "$2" "$1" || die "could not download ${1}"
  else
    wget -qO "$2" "$1" || die "could not download ${1}"
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

fetch_caddy() {
  expected="$CADDY_SHA256_amd64"
  [ "$ARCH" = 'arm64' ] && expected="$CADDY_SHA256_arm64"

  name="caddy_${CADDY_VERSION}_linux_${ARCH}.tar.gz"
  download "$(artifact_url \
    "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${name}" "$name")" \
    "${WORK}/caddy.tar.gz"
  verify "${WORK}/caddy.tar.gz" "$expected" "caddy ${CADDY_VERSION} (${ARCH})"

  tar -xzf "${WORK}/caddy.tar.gz" -C "$WORK" caddy
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
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" \
      || die "could not create the \"${SERVICE_USER}\" system user"
    say "created system user ${SERVICE_USER}"
  fi
  if ! id "$CADDY_USER" >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/caddy --shell /usr/sbin/nologin "$CADDY_USER" \
      || die "could not create the \"${CADDY_USER}\" system user"
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
    say "keeping ${CONFIG_DIR}/caddy.json"
  else
    # The one thing this file must have is a server the node may write into:
    # the driver adds and removes routes carrying its own "scafo_" @id prefix
    # inside it and touches nothing else, so an operator's own routes can live
    # in the same array and survive every reconcile pass.
    #
    # The access log is written here because it costs nothing while
    # SCAFO_INGRESS_ACCESS_LOG stays commented out, and turning counting on
    # later is then one line in node.env rather than a Caddy restart. "mode":
    # "0644" is what lets the node, running as another user, read what Caddy
    # writes as its own.
    cat > "${CONFIG_DIR}/caddy.json" <<EOF
{
  "admin": {
    "listen": "127.0.0.1:2019"
  },
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
    chmod 0644 "${CONFIG_DIR}/caddy.json"
    say "wrote ${CONFIG_DIR}/caddy.json"
  fi
}

write_units() {
  # THE ORDER IS THE POINT. A Caddy that stores its TLS material through the
  # node — which is what the `caddy.storage.scafo` build does, and what this
  # host will run the day it joins a fleet — reads the node's /v1/storage and the
  # storage token the node MINTS ON ITS FIRST BOOT. Started first, it finds
  # neither. Plain Caddy does not care, but the ordering is written now so that
  # replacing the binary is the only change that has to be made later.
  cat > /etc/systemd/system/scafo-node.service <<EOF
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
ExecStart=${BIN_DIR}/scafo up
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

  cat > /etc/systemd/system/${CADDY_USER}.service <<EOF
[Unit]
Description=Caddy, the ingress a scafo node routes through
Documentation=https://caddyserver.com/docs/
Wants=network-online.target
After=network-online.target scafo-node.service

[Service]
Type=notify
User=${CADDY_USER}
Group=${CADDY_USER}
ExecStart=${BIN_DIR}/caddy run --config ${CONFIG_DIR}/caddy.json
ExecReload=${BIN_DIR}/caddy reload --config ${CONFIG_DIR}/caddy.json --force
Restart=on-failure
RestartSec=5s
TimeoutStopSec=5s

# Certificates and the ACME account, on this host's disk. Per-node: see the
# note about fleet-shared TLS at the top of the installer.
StateDirectory=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/var/lib/caddy
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
  say "    ${BIN_DIR}/scafo up --listen 127.0.0.1:7400"
  say ''
  say "  ${BIN_DIR}/caddy run --config ./caddy.json"
  say ''
  say 'Whatever supervises them must give the node AT LEAST 35 SECONDS between'
  say 'SIGTERM and SIGKILL, and must signal the agent alone rather than every'
  say 'process beside it: it drains its runtimes itself, in an order that matters.'
}

next_steps() {
  printf '\n'
  printf 'scafo is installed.\n\n'
  printf '  %s/scafo    %s\n' "$BIN_DIR" "$(scafo_version)"
  printf '  %s/celld    %s\n' "$BIN_DIR" "$CELLD_VERSION"
  printf '  %s/caddy    %s\n' "$BIN_DIR" "$CADDY_VERSION"
  printf '  %s/esbuild  %s\n' "$BIN_DIR" "$ESBUILD_VERSION"
  printf '\n'
  printf 'The scafo binary was %s.\n' "$SCAFO_CHECKSUM_SOURCE"

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
    printf '     scafo keygen --register\n\n'
    printf '   The key lands in ./scafo-operator.json, which is where "scafo deploy"\n'
    printf '   looks for it. Back it up: nothing can reissue it.\n\n'
    printf '4. Deploy something:\n\n'
    printf '     scafo deploy ./my-app --agent http://127.0.0.1:7400 \\\n'
    printf '       --project shop --env production --flip\n\n'
  else
    printf '1. Run the node and the ingress as described above.\n'
    printf '2. Mint an operator key with the same bucket settings exported:\n\n'
    printf '     scafo keygen --register\n\n'
    printf '3. Deploy something:\n\n'
    printf '     scafo deploy ./my-app --agent http://127.0.0.1:7400 \\\n'
    printf '       --project shop --env production --flip\n\n'
  fi

  printf 'WHERE THINGS ARE\n\n'
  printf '  %-28s node identity, 0600 in a %s directory\n' "${STATE_DIR}/node.json" "$STATE_DIR_MODE"
  printf '  %-28s the token the ingress presents to /v1/storage,\n' "${STATE_DIR}/storage-token"
  printf '  %-28s minted on the first boot. LOCAL OR TUNNELLED CALLERS ONLY:\n' ''
  printf '  %-28s that surface carries private keys in both directions.\n' ''
  if [ "$UNITS_WRITTEN" = 'yes' ]; then
    printf '  %-28s bucket credentials and every other setting\n' "${CONFIG_DIR}/node.env"
    printf '  %-28s the ingress config the node writes its routes into\n' "${CONFIG_DIR}/caddy.json"
    printf '  %-28s where Caddy logs what it served, when asked to\n' "${INGRESS_LOG_DIR}/"
  fi

  printf '\nWHAT THIS INSTALL IS NOT\n\n'
  printf '  * TLS IS PER-NODE. Plain Caddy keeps its certificates on this host, so\n'
  printf '    a second node issues its own for the same names — which is fine until\n'
  printf '    it is a rate limit. Fleet-shared TLS reads one certificate out of the\n'
  printf '    bucket through the node itself and needs the Caddy built with the\n'
  printf '    caddy.storage.scafo module, which is not published as a plain binary\n'
  printf '    yet. Moving to it is a new binary and a "storage" block in\n'
  printf '    %s/caddy.json; nothing here has to be undone.\n' "$CONFIG_DIR"
  printf '  * NO WIREGUARD. A tunnel needs a kernel module and NET_ADMIN, so it is\n'
  printf '    your package manager'\''s job:\n\n'
  printf '      apt install wireguard-tools   # or dnf, apk, pacman\n\n'
  printf '    Then "scafo wg init" writes wg0.conf and prints the wg-quick command.\n'
  printf '    A single node that never leaves loopback needs none of it.\n'
  printf '  * NOTHING WAS STARTED. See NEXT above.\n\n'
}

scafo_version() {
  "${BIN_DIR}/scafo" --version 2>/dev/null || echo '(unknown)'
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
