#!/bin/sh
# Installs verified scafo, Celld, Caddy, and esbuild binaries.
# Root on a systemd host also writes, but does not start, node and ingress units.
# The ingress is `scafo-caddy`, and only `scafo-caddy`: it carries the two modules
# this install depends on — `caddy.storage.scafo`, which keeps TLS material in the
# bucket through the node's storage API without a bucket credential, and the
# `scafo` dynamic-upstreams source, which PULLS the fleet's routing off this node.
# Upstream Caddy has neither, so it cannot route for scafo at all.
# The ingress receives a systemd credential copy of the ingress token; do not widen
# the token's source-file permissions.
#
# Environment: `SCAFO_INSTALL_BASE`, `SCAFO_VERSION`, and `SCAFO_SHA256` select
# and verify scafo; `SCAFO_CADDY_BASE` and `SCAFO_CADDY_SHA256` do the same for
# scafo-caddy; `SCAFO_INSTALL_BIN_DIR` changes the destination; and
# `SCAFO_INSTALL_MIRROR` mirrors pinned third-party artifacts. `SCAFO_INSTALL_SKIP_UNITS=1`
# skips systemd units. A sidecar `.sha256` verifies integrity; set the checksum
# variable to authenticate a latest-release download.
#
# Only the stable channel is served here: GitHub releases, latest or pinned by
# `SCAFO_VERSION`. The edge channel (every commit on main) ships as the
# `ghcr.io/sandros94/scafo:edge` image, with its binaries kept only as run
# artifacts; point `SCAFO_INSTALL_BASE` at a mirror of those to install one.

set -eu

# Keep these install targets aligned with `scripts/uninstall.sh`; its manifest is optional.

CELLD_VERSION='0.5.0'
CELLD_SHA256_amd64='1039eee3737bb432ca0cd399fc55cc0aab4e653b2beae26009e455fea4e5334c'
CELLD_SHA256_arm64='bd3965f78f96c755b64b0280746a7c26116fa9df01a9e57c5930e9752945c993'

ESBUILD_VERSION='0.28.2'
ESBUILD_SHA256_amd64='9573bb2233aab0f9ea7647d5cca9726113cc1768de61d66b17267f4db84488f6'
ESBUILD_SHA256_arm64='a96dbfa41d3ef5dbd1ef22b1c10d5187be9267e86093a870f06402a7ec931596'

# The state directory holds node identity and must remain private.
STATE_DIR='/var/lib/scafo'
STATE_DIR_MODE='0700'
CONFIG_DIR='/etc/scafo'
INGRESS_LOG_DIR='/var/log/scafo-ingress'
SERVICE_USER='scafo'
CADDY_USER='caddy'
# This matches the ingress unit's `StateDirectory`. The certificates are NOT here —
# they are in the bucket, through the node — so this holds little more than scratch.
CADDY_STATE_DIR='/var/lib/caddy'

# Keep the node token, ingress credential, and ingress config name aligned.
INGRESS_TOKEN_NAME='ingress-token'
# Must match `SCAFO_LISTEN` in the generated node environment.
STORAGE_ENDPOINT='http://127.0.0.1:7400'

# Allow node draining plus the runtime's 40-second shutdown bound.
STOP_TIMEOUT='50'

DEFAULT_INSTALL_BASE_LATEST='https://github.com/sandros94/scafo/releases/latest/download'
DEFAULT_INSTALL_BASE_TAGGED='https://github.com/sandros94/scafo/releases/download'
DEFAULT_CADDY_BASE='https://github.com/sandros94/scafo-ingress/releases/latest/download'

# ---------------------------------------------------------------------------

main() {
  # Recorded by `write_manifest` for precise uninstall behavior.
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
  resolve_destination

  say "installing into ${BIN_DIR} for ${OS}-${ARCH}"
  say 'ingress: scafo-caddy (TLS material in the bucket, routing pulled from this node)'

  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT INT TERM

  # Verify all downloads before changing the host.
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

  # All installed binaries require glibc.
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

# Use an explicit directory, `/usr/local/bin` with non-interactive privilege, or `~/.local/bin`.
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

# Use only already available non-interactive privilege.
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

# An optional failure message identifies a download or access failure.
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

# Verify every downloaded artifact before extracting or installing it.
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

# Mirrors retain the pinned checksum verification.
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

  # A supplied checksum authenticates the binary; a sidecar checksum checks integrity only.
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

# Staged as `${WORK}/caddy`. Latest scafo-caddy releases require an explicit
# checksum pin for authentication.
fetch_caddy() {
  base="${SCAFO_CADDY_BASE:-$DEFAULT_CADDY_BASE}"
  name="scafo-caddy-${OS}-${ARCH}"

  download "${base}/${name}" "${WORK}/caddy" \
    "could not download ${base}/${name}

  Check that the release asset exists and this host can access it. There is no
  fallback: upstream Caddy carries neither caddy.storage.scafo nor the scafo
  dynamic-upstreams source, so it cannot hold this fleet's TLS material and
  cannot answer for a single deployed name.

  SCAFO_CADDY_BASE selects another compatible artifact base. Provide
  ${name}.sha256 there or set SCAFO_CADDY_SHA256."

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

# Esbuild is distributed as a platform npm package rather than a release asset.
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
  # Record only accounts created by this install so uninstall does not remove host-owned accounts.
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

  # Preserve operator-provided bucket credentials across reinstalls.
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

# The names applications are served under: <name>.<domain>. Comma-separated.
SCAFO_PLATFORM_DOMAINS=

# The node API. Loopback needs no further statement about the network; widening
# it makes the node refuse to boot until SCAFO_TRANSPORT says what that network
# is — "wireguard" to tunnel it, "none" to state that it is already private.
SCAFO_LISTEN=127.0.0.1:7400
#SCAFO_ADVERTISE=
#SCAFO_TRANSPORT=

# The ingress is not configured from here. It READS the fleet's routing off this
# node's API, at /v1/ingress/routes behind the ingress token, and follows it.

# What this machine IS, for applications that ask for a class of node.
#SCAFO_NODE_LABELS=tier=fast,region=eu-west-1

# Upstream Celld policy for every runtime process, comma-separated. Scafo adds
# no durability, idle-eviction or memory defaults. If SHUTDOWN_TOTAL_MS is
# raised above 40000, also raise TimeoutStopSec in scafo-node.service to at
# least that value plus 10 seconds.
#SCAFO_CELLD_ENV=CELLD_MAX_RSS_MB=512,CELLD_MAX_RESIDENT_CELLS=64

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
    # An operator's edits outrank the generated file; never rewrite one that exists.
    say "keeping ${CONFIG_DIR}/caddy.json"
  else
    render_caddy_json > "${CONFIG_DIR}/caddy.json"
    chmod 0644 "${CONFIG_DIR}/caddy.json"
    say "wrote ${CONFIG_DIR}/caddy.json"
  fi
}

# Generate the tested ingress config. Nothing pushes into this file or into
# Caddy: the ingress PULLS the fleet's routing from this node and follows it.
# There is no "admin" block on purpose — no one calls Caddy's admin API any more,
# and Caddy's own default (localhost:2019) is what the unit's ExecReload needs.
# The readable access log supports opt-in counters.
render_caddy_json() {
  # Every block naming the node reads the private systemd credential copy of the
  # ingress token, never the source file.
  cat <<EOF
{
  "storage": {
    "module": "scafo",
    "endpoint": "${STORAGE_ENDPOINT}",
    "token_file": "{env.CREDENTIALS_DIRECTORY}/${INGRESS_TOKEN_NAME}"
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
EOF

  # This ingress answers on :443 for names it only learns at request time, so
  # every certificate is on demand — and the node, not Caddy, decides which names
  # deserve one. Without this the server would listen and serve nothing.
  cat <<EOF
    "tls": {
      "automation": {
        "policies": [{ "on_demand": true }],
        "on_demand": {
          "permission": {
            "module": "http",
            "endpoint": "${STORAGE_ENDPOINT}/v1/ingress/ask"
          }
        }
      }
    },
EOF

  # One catch-all route. The upstreams source polls this node, caches the routing
  # document, and resolves the request's Host to that name's upstreams. The list
  # is a PRIORITY, not a weighting — this node first, hence "first" rather than a
  # balancing policy — and passive health checks step down the list when the head
  # of it keeps failing.
  cat <<EOF
    "http": {
      "servers": {
        "scafo": {
          "listen": [":80", ":443"],
          "routes": [
            {
              "handle": [
                {
                  "handler": "reverse_proxy",
                  "dynamic_upstreams": {
                    "source": "scafo",
                    "endpoint": "${STORAGE_ENDPOINT}",
                    "token_file": "{env.CREDENTIALS_DIRECTORY}/${INGRESS_TOKEN_NAME}",
                    "prefer": "self"
                  },
                  "load_balancing": {
                    "selection_policy": { "policy": "first" },
                    "retries": 2,
                    "try_duration": "5s"
                  },
                  "health_checks": {
                    "passive": { "fail_duration": "30s", "max_fails": 1 }
                  }
                }
              ]
            }
          ],
EOF

  # A name nobody deployed and a path the node refused are ONE answer here, on
  # purpose: 404 either way, so a denial never confirms that the path exists.
  cat <<EOF
          "errors": {
            "routes": [
              {
                "match": [{ "vars": { "scafo.route": ["unknown", "denied"] } }],
                "handle": [
                  {
                    "handler": "static_response",
                    "status_code": 404,
                    "body": "No deployment answers to this name.\\n"
                  }
                ]
              }
            ]
          },
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
  # Unit files remain usable if the optional daemon reload fails.
  if systemctl daemon-reload 2>/dev/null; then
    say 'ran systemctl daemon-reload'
  else
    warn 'the units are written but "systemctl daemon-reload" did not run; run it yourself'
  fi
}

# Start the node before ingress so the ingress token exists on first boot.
render_node_unit() {
  cat <<EOF
[Unit]
Description=scafo node daemon
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
# Default Celld source builds to the bundled esbuild binary.
Environment=CELLD_ESBUILD=${BIN_DIR}/esbuild
Environment=SCAFO_CELLD_BIN=${BIN_DIR}/celld
ExecStart=${BIN_DIR}/scafo sail
Restart=on-failure
RestartSec=5s

# Signal the daemon first so it drains runtimes; kill remaining cgroup processes on timeout.
KillMode=mixed
KillSignal=SIGTERM
SendSIGKILL=yes
TimeoutStopSec=${STOP_TIMEOUT}s
# Keep runtimes in this cgroup for timeout containment.
Delegate=no

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
# The token is unavailable on first boot until the node starts. LoadCredential=
# fails before ExecStartPre, so disable start-rate limiting and retry on failure.
# Do not add Requires=: a running ingress may continue through a node restart.
StartLimitIntervalSec=0

[Service]
Type=notify
User=${CADDY_USER}
Group=${CADDY_USER}
# This gives the ingress a private copy without exposing the source token.
LoadCredential=${INGRESS_TOKEN_NAME}:${STATE_DIR}/${INGRESS_TOKEN_NAME}
ExecStart=${BIN_DIR}/caddy run --config ${CONFIG_DIR}/caddy.json
ExecReload=${BIN_DIR}/caddy reload --config ${CONFIG_DIR}/caddy.json --force
Restart=on-failure
RestartSec=5s
TimeoutStopSec=5s

# Caddy's own state directory. The certificates and the ACME account are NOT
# here — they are in the bucket, reached through the node — so this holds little
# more than scratch. Set anyway, so nothing Caddy writes has nowhere to land.
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

# Record install-specific paths and created accounts for precise uninstall;
# uninstall can derive safe defaults if the manifest is absent.
write_manifest() {
  manifest="${STATE_DIR}/install.manifest"
  # Preserve prior created accounts across reinstalls for a later `--purge`.
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
    # Only scafo-caddy is installable now, but the key stays: uninstall.sh reads
    # it, and an older manifest on this host may still say something else.
    printf 'caddy_flavor=scafo\n'
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
  say 'ingress token the node mints on its first boot:'
  say ''
  say "  install -d -m ${STATE_DIR_MODE} ${STATE_DIR}"
  say "  SCAFO_STATE_DIR=${STATE_DIR} \\"
  say "  CELLD_ESBUILD=${BIN_DIR}/esbuild SCAFO_CELLD_BIN=${BIN_DIR}/celld \\"
  say "  SCAFO_S3_ENDPOINT=... SCAFO_S3_BUCKET=... SCAFO_S3_ACCESS_KEY=... \\"
  say "  SCAFO_S3_SECRET_KEY=... SCAFO_PLATFORM_DOMAINS=... \\"
  say "    ${BIN_DIR}/scafo sail --listen 127.0.0.1:7400"
  say ''
  say "  ${BIN_DIR}/caddy run --config ./caddy.json"
  say ''
  # A hand-run ingress reads the SOURCE token: there is no systemd credential
  # directory to point at, so both blocks name the file the node minted.
  say 'THAT CADDY IS scafo-caddy, and BOTH of its scafo modules have to name this'
  say 'node — one for the TLS material, one for the routing it follows. Write'
  say './caddy.json with:'
  say ''
  say '  "storage": {'
  say '    "module": "scafo",'
  say "    \"endpoint\": \"${STORAGE_ENDPOINT}\","
  say "    \"token_file\": \"${STATE_DIR}/${INGRESS_TOKEN_NAME}\""
  say '  },'
  say ''
  say '  ... and, inside the reverse_proxy handler that answers for everything:'
  say ''
  say '  "dynamic_upstreams": {'
  say '    "source": "scafo",'
  say "    \"endpoint\": \"${STORAGE_ENDPOINT}\","
  say "    \"token_file\": \"${STATE_DIR}/${INGRESS_TOKEN_NAME}\","
  say '    "prefer": "self"'
  say '  }'
  say ''
  say 'The token is minted 0600 by whoever runs the node. Under systemd this'
  say 'script hands it over with LoadCredential= and nothing is loosened;'
  say 'running both by hand, the ingress must be a user that can read it —'
  say 'the same user as the node, or a group you give it yourself.'
  say ''
  say 'Whatever supervises them must give the node AT LEAST 50 SECONDS between'
  say 'SIGTERM and SIGKILL, and must signal the daemon alone rather than every'
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
  printf 'The scafo-caddy binary was %s.\n' "$CADDY_CHECKSUM_SOURCE"

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
    printf '   SCAFO_S3_ENDPOINT, SCAFO_S3_BUCKET, SCAFO_S3_ACCESS_KEY and\n'
    printf '   SCAFO_S3_SECRET_KEY are the required four; SCAFO_PLATFORM_DOMAINS names\n'
    printf '   the domains apps are served under, and apps get no host without it.\n\n'
    printf '2. Start it, and the ingress with it:\n\n'
    printf '     systemctl enable --now scafo-node.service\n'
    printf '     systemctl status scafo-node.service %s.service\n\n' "$CADDY_USER"
    printf '3. Mint an operator key. It signs everything you ask a node to do, and\n'
    printf '   it reads the SAME bucket settings — export them into your shell first:\n\n'
    printf '     scafo operator keygen --register\n\n'
    printf '   The key lands in ./scafo-operator.json, which is where "scafo deploy"\n'
    printf '   looks for it. Back it up: nothing can reissue it.\n\n'
    printf '4. Deploy something:\n\n'
    printf '     scafo deploy ./my-app --node http://127.0.0.1:7400 \\\n'
    printf '       --name shop\n\n'
  else
    printf '1. Run the node and the ingress as described above.\n'
    printf '2. Mint an operator key with the same bucket settings exported:\n\n'
    printf '     scafo operator keygen --register\n\n'
    printf '3. Deploy something:\n\n'
    printf '     scafo deploy ./my-app --node http://127.0.0.1:7400 \\\n'
    printf '       --name shop\n\n'
  fi

  printf 'WHERE THINGS ARE\n\n'
  printf '  %-32s node identity, 0600 in a %s directory\n' "${STATE_DIR}/node.json" "$STATE_DIR_MODE"
  printf '  %-32s the token the ingress presents to /v1/ingress and /v1/storage,\n' "${STATE_DIR}/${INGRESS_TOKEN_NAME}"
  printf '  %-32s minted on the first boot. LOCAL OR TUNNELLED CALLERS ONLY:\n' ''
  printf '  %-32s that surface carries private keys in both directions.\n' ''
  if [ "$UNITS_WRITTEN" = 'yes' ]; then
    printf '  %-32s 0600 and left that way: systemd reads it as root\n' ''
    printf '  %-32s (LoadCredential=) and hands the ingress a private copy.\n' ''
    printf '  %-32s bucket credentials and every other setting\n' "${CONFIG_DIR}/node.env"
    printf '  %-32s the ingress config: where the ingress is told to read\n' "${CONFIG_DIR}/caddy.json"
    printf '  %-32s this node for TLS material and for the routing\n' ''
    printf '  %-32s where Caddy logs what it served, when asked to\n' "${INGRESS_LOG_DIR}/"
    printf '  %-32s what this run installed, for scripts/uninstall.sh\n' "${STATE_DIR}/install.manifest"
  fi

  printf '\nWHAT THIS INSTALL IS NOT\n\n'
  printf '  * THE INGRESS HAS NO BUCKET CREDENTIAL, AND MUST NOT GET ONE. scafo-caddy\n'
  printf '    keeps its certificates, their keys and its ACME account in the bucket by\n'
  printf '    asking THIS NODE for them over %s — a loopback URL\n' "$STORAGE_ENDPOINT"
  printf '    and a bearer token, nothing more. That is the point of it: every node in\n'
  printf '    the fleet serves the one certificate, and the most exposed process on the\n'
  printf '    host still cannot address the bucket.\n'
  printf '  * NOTHING IS PUSHED INTO THE INGRESS. It reads the fleet'\''s routing off\n'
  printf '    this node, over that same URL and token, and follows it; a name nobody\n'
  printf '    deployed gets a 404 and no certificate is issued for it.\n'
  if [ "$UNITS_WRITTEN" = 'yes' ]; then
    printf '    ON THE FIRST BOOT THE INGRESS WILL FAIL AND RETRY for as long as it\n'
    printf '    takes the node to mint that token — seconds, normally. It is written to\n'
    printf '    do exactly that (Restart=on-failure with the start rate limit off), so\n'
    printf '    "243/CREDENTIALS" in the first moments of the journal is the design and\n'
    printf '    not a fault. It stops the moment the token is there.\n'
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

# scafo-caddy tracks its own release, so ask the installed binary what it is.
caddy_label() {
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
