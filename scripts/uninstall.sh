#!/bin/sh
# Remove units, binaries, and configuration after stopping ingress before the node.
# A normal run preserves node state, ingress state, logs, and created accounts;
# `--purge` removes them. Neither mode changes the bucket or its registry.
# `SCAFO_INSTALL_BIN_DIR` or `--bin-dir` identifies a non-default binary directory.
# The optional install manifest records exact paths and created accounts; safe
# fallbacks support hosts without one.

set -eu

# Keep these defaults aligned with `scripts/install.sh`; they are used without a manifest.

STATE_DIR='/var/lib/scafo'
CONFIG_DIR='/etc/scafo'
INGRESS_LOG_DIR='/var/log/scafo-ingress'
# Matches the ingress unit's `StateDirectory` and XDG paths.
CADDY_STATE_DIR='/var/lib/caddy'
SERVICE_USER='scafo'
CADDY_USER='caddy'

UNIT_DIR='/etc/systemd/system'
NODE_UNIT='scafo-node.service'
# The ingress unit uses its service-account name.
INGRESS_UNIT='caddy.service'

# Both ingress variants install as `caddy`; the manifest flavor is report-only.
BINARIES='scafo celld caddy esbuild'

MANIFEST_NAME='install.manifest'

# Never accept host-owned directories as removal targets.
NEVER_REMOVE='/ /bin /boot /dev /etc /home /lib /opt /proc /root /run /sbin /srv
/sys /tmp /usr /usr/bin /usr/local /usr/local/bin /usr/sbin /var /var/lib /var/log'

# ---------------------------------------------------------------------------

main() {
  PURGE='no'
  DRY_RUN='no'
  BIN_DIR_OPT=''
  REMOVED_LINES=''
  KEPT_LINES=''
  ROOT_WORK=''
  MANIFEST_READ='no'
  BIN_DIR_SOURCE=''

  parse_args "$@"

  resolve_privilege
  read_manifest
  resolve_bin_dir
  survey
  require_privilege

  if [ "$DRY_RUN" = 'yes' ]; then
    say 'dry run: nothing on this host will be changed'
  fi
  say "taking apart the scafo install in ${BIN_DIR} (${BIN_DIR_SOURCE})"

  stop_units
  remove_units
  remove_binaries
  remove_config
  remove_state

  report
}

usage() {
  cat <<'EOF'
scafo — undo scripts/install.sh on this host.

  uninstall.sh [--purge] [--dry-run] [--bin-dir <dir>]

  --purge           also remove the state directory (/var/lib/scafo — the node
                    identity and the ingress token, which nothing can reissue),
                    the ingress's certificates and ACME account (/var/lib/caddy),
                    what it logged (/var/log/scafo-ingress) and the system users
                    this install created.
  --dry-run, -n     print every removal without performing any of them.
  --bin-dir <dir>   where the executables were installed. Defaults to the
                    manifest, then to the unit's ExecStart, then to
                    SCAFO_INSTALL_BIN_DIR, then to install.sh's own default.
  -h, --help        this.

It never touches the bucket. The registry is the fleet's, and a node that has
stopped is counted out of placement on its own.
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --purge) PURGE='yes' ;;
      --dry-run | -n) DRY_RUN='yes' ;;
      --bin-dir)
        shift
        [ "$#" -gt 0 ] || die '--bin-dir needs a directory'
        BIN_DIR_OPT="$1"
        ;;
      --bin-dir=*) BIN_DIR_OPT="${1#--bin-dir=}" ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument \"$1\"; one of: --purge, --dry-run, --bin-dir <dir>, --help"
        ;;
    esac
    shift
  done
}

# Use only already available non-interactive privilege.

resolve_privilege() {
  SUDO=''
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
      SUDO='sudo'
    fi
  fi
}

as_root() {
  if [ -n "$SUDO" ]; then
    $SUDO "$@"
  else
    "$@"
  fi
}

# Refuse a real partial uninstall when root-owned targets were found.
require_privilege() {
  [ -n "$ROOT_WORK" ] || return 0
  [ "$(id -u)" -ne 0 ] || return 0
  [ -z "$SUDO" ] || return 0

  # Dry runs are read-only and may inspect root-owned installs without privilege.
  if [ "$DRY_RUN" = 'yes' ]; then
    warn 'this install belongs to root; a real run needs "sudo sh uninstall.sh"'
    return 0
  fi

  printf 'scafo: this install belongs to root, and this is not root:\n' >&2
  printf '%s' "$ROOT_WORK" >&2
  die 'Re-run it as root:

  sudo sh uninstall.sh'
}

note_root_work() {
  ROOT_WORK="${ROOT_WORK}  ${1}
"
}

# Manifest fields are optional; absent values fall back to safe defaults.
read_manifest() {
  MANIFEST_BIN_DIR=''
  MANIFEST_BINARIES=''
  MANIFEST_UNITS=''
  MANIFEST_CREATED_USERS=''
  MANIFEST_CONFIG_DIR=''
  MANIFEST_INGRESS_LOG_DIR=''
  MANIFEST_CADDY_STATE_DIR=''
  MANIFEST_CADDY_FLAVOR=''
  manifest="${STATE_DIR}/${MANIFEST_NAME}"

  [ -f "$manifest" ] || return 0
  [ -r "$manifest" ] || {
    warn "${manifest} is not readable by this user; deriving what to remove instead"
    return 0
  }

  # Keep a final non-newline-terminated manifest line.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '#'* | '') ;;
      bin_dir=*) MANIFEST_BIN_DIR="${line#bin_dir=}" ;;
      binary=*) MANIFEST_BINARIES="${MANIFEST_BINARIES} ${line#binary=}" ;;
      unit=*) MANIFEST_UNITS="${MANIFEST_UNITS} ${line#unit=}" ;;
      created_user=*) MANIFEST_CREATED_USERS="${MANIFEST_CREATED_USERS} ${line#created_user=}" ;;
      config_dir=*) MANIFEST_CONFIG_DIR="${line#config_dir=}" ;;
      ingress_log_dir=*) MANIFEST_INGRESS_LOG_DIR="${line#ingress_log_dir=}" ;;
      caddy_state_dir=*) MANIFEST_CADDY_STATE_DIR="${line#caddy_state_dir=}" ;;
      # Flavor affects reporting only.
      caddy_flavor=*) MANIFEST_CADDY_FLAVOR="${line#caddy_flavor=}" ;;
      *) ;;
    esac
  done < "$manifest"

  MANIFEST_READ='yes'
  say "read ${manifest}"

  # Adopt only removable manifest paths; the containing state directory is fixed.
  adopt "$MANIFEST_CONFIG_DIR" && CONFIG_DIR="$MANIFEST_CONFIG_DIR"
  adopt "$MANIFEST_INGRESS_LOG_DIR" && INGRESS_LOG_DIR="$MANIFEST_INGRESS_LOG_DIR"
  adopt "$MANIFEST_CADDY_STATE_DIR" && CADDY_STATE_DIR="$MANIFEST_CADDY_STATE_DIR"
  return 0
}

# Accept only non-empty paths this script may remove.
adopt() {
  [ -n "$1" ] || return 1
  safe_path "$1" || {
    warn "ignoring \"${1}\" from the manifest: not a path this script may remove"
    return 1
  }
}

# Resolve the binary directory from explicit input, manifest, unit, environment, PATH, or installer default.
resolve_bin_dir() {
  if [ -n "$BIN_DIR_OPT" ]; then
    BIN_DIR="$BIN_DIR_OPT"
    BIN_DIR_SOURCE='--bin-dir'
  elif [ -n "$MANIFEST_BIN_DIR" ]; then
    BIN_DIR="$MANIFEST_BIN_DIR"
    BIN_DIR_SOURCE='from the manifest'
  elif [ -n "${SCAFO_INSTALL_BIN_DIR:-}" ]; then
    BIN_DIR="$SCAFO_INSTALL_BIN_DIR"
    BIN_DIR_SOURCE='SCAFO_INSTALL_BIN_DIR'
  elif bin_dir_from_unit; then
    BIN_DIR="$UNIT_BIN_DIR"
    BIN_DIR_SOURCE="from ${NODE_UNIT}"
  elif bin_dir_from_path; then
    BIN_DIR="$PATH_BIN_DIR"
    BIN_DIR_SOURCE='from the scafo on PATH'
  elif [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; then
    BIN_DIR='/usr/local/bin'
    BIN_DIR_SOURCE="install.sh's default"
  else
    BIN_DIR="${HOME:-}/.local/bin"
    BIN_DIR_SOURCE="install.sh's default for a normal user"
  fi
}

bin_dir_from_unit() {
  UNIT_BIN_DIR=''
  [ -r "${UNIT_DIR}/${NODE_UNIT}" ] || return 1
  # `ExecStart=/usr/local/bin/scafo sail` -> /usr/local/bin
  unit_exec="$(sed -n 's/^ExecStart=\([^ ]*\)\/scafo .*$/\1/p' "${UNIT_DIR}/${NODE_UNIT}" 2>/dev/null | head -n 1)"
  [ -n "$unit_exec" ] || return 1
  UNIT_BIN_DIR="$unit_exec"
}

bin_dir_from_path() {
  PATH_BIN_DIR=''
  path_scafo="$(command -v scafo 2>/dev/null || true)"
  [ -n "$path_scafo" ] || return 1
  PATH_BIN_DIR="${path_scafo%/*}"
  [ -n "$PATH_BIN_DIR" ] || return 1
}

# Survey targets before stopping or deleting anything.
survey() {
  FOUND_UNITS=''
  FOUND_BINARIES=''

  for unit in $(units_to_remove); do
    if [ -f "${UNIT_DIR}/${unit}" ]; then
      FOUND_UNITS="${FOUND_UNITS} ${unit}"
      note_root_work "${UNIT_DIR}/${unit}"
    fi
  done

  for name in $(binaries_to_remove); do
    if [ -e "${BIN_DIR}/${name}" ]; then
      FOUND_BINARIES="${FOUND_BINARIES} ${name}"
    fi
  done
  if [ -n "$FOUND_BINARIES" ] && [ ! -w "$BIN_DIR" ]; then
    note_root_work "${BIN_DIR}/ (${FOUND_BINARIES# })"
  fi

  [ ! -d "$CONFIG_DIR" ] || note_root_work "$CONFIG_DIR"

  if [ "$PURGE" = 'yes' ]; then
    [ ! -d "$STATE_DIR" ] || note_root_work "$STATE_DIR"
    [ ! -d "$CADDY_STATE_DIR" ] || note_root_work "$CADDY_STATE_DIR"
    [ ! -d "$INGRESS_LOG_DIR" ] || note_root_work "$INGRESS_LOG_DIR"
    for user in $(users_to_remove); do
      note_root_work "the \"${user}\" system user"
    done
  fi
}

units_to_remove() {
  if [ -n "$MANIFEST_UNITS" ]; then
    for unit_path in $MANIFEST_UNITS; do
      printf '%s\n' "${unit_path##*/}"
    done
    return 0
  fi
  printf '%s\n%s\n' "$NODE_UNIT" "$INGRESS_UNIT"
}

binaries_to_remove() {
  if [ -n "$MANIFEST_BINARIES" ]; then
    for name in $MANIFEST_BINARIES; do
      printf '%s\n' "$name"
    done
    return 0
  fi
  for name in $BINARIES; do
    printf '%s\n' "$name"
  done
}

# With a manifest, remove only accounts it recorded as created. Without one,
# remove only the service account whose home matches the state directory.
users_to_remove() {
  if [ "$MANIFEST_READ" = 'yes' ]; then
    for user in $MANIFEST_CREATED_USERS; do
      user_exists "$user" && printf '%s\n' "$user"
    done
    return 0
  fi
  if user_exists "$SERVICE_USER" && [ "$(user_home "$SERVICE_USER")" = "$STATE_DIR" ]; then
    printf '%s\n' "$SERVICE_USER"
  fi
}

user_exists() {
  id "$1" >/dev/null 2>&1
}

user_home() {
  if command -v getent >/dev/null 2>&1; then
    getent passwd "$1" 2>/dev/null | cut -d: -f6
  else
    printf ''
  fi
}

have_systemd() {
  [ -d /run/systemd/system ] || return 1
  command -v systemctl >/dev/null 2>&1 || return 1
}

# Stop ingress before the node to avoid routing to draining runtimes. `systemctl stop`
# waits for the node's configured drain time.
stop_units() {
  have_systemd || return 0

  for unit in $INGRESS_UNIT $NODE_UNIT; do
    contains "$FOUND_UNITS" "$unit" || continue

    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      if [ "$unit" = "$NODE_UNIT" ]; then
        say 'the node drains its runtimes on the way out — this takes up to 50s'
      fi
      run_step "stopped ${unit}" "stop ${unit}" systemctl stop "$unit" || true
    fi

    if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
      run_step "disabled ${unit}" "disable ${unit}" systemctl disable "$unit" || true
    fi

    # Clear a failed-unit record before removing its unit file.
    if [ "$DRY_RUN" = 'no' ]; then
      as_root systemctl reset-failed "$unit" >/dev/null 2>&1 || true
    fi
  done
}

remove_units() {
  removed_any='no'

  for unit in $FOUND_UNITS; do
    note='systemd unit'
    if [ "$unit" = "$INGRESS_UNIT" ]; then
      # Removing this override may restore a distribution-provided Caddy unit.
      note='systemd unit (a packaged caddy.service, if any, applies again)'
    fi
    remove_path "${UNIT_DIR}/${unit}" "$note" && removed_any='yes'

    # Remove the enablement symlink even when systemd was not running.
    remove_quietly "${UNIT_DIR}/multi-user.target.wants/${unit}"
  done

  [ "$removed_any" = 'yes' ] || return 0
  have_systemd || return 0
  if [ "$DRY_RUN" = 'yes' ]; then
    say 'would run systemctl daemon-reload'
    return 0
  fi
  if as_root systemctl daemon-reload 2>/dev/null; then
    say 'ran systemctl daemon-reload'
  else
    warn 'the units are gone but "systemctl daemon-reload" did not run; run it yourself'
  fi
}

# Remove only recorded executable names from the resolved installation directory.
remove_binaries() {
  for name in $FOUND_BINARIES; do
    remove_path "${BIN_DIR}/${name}" "$(binary_note "$name")" || true
  done
}

# The manifest flavor adds the Caddy TLS-storage detail to the report.
binary_note() {
  [ "$1" = 'caddy' ] || {
    printf 'executable\n'
    return 0
  }
  case "$MANIFEST_CADDY_FLAVOR" in
    scafo) printf 'executable (scafo-caddy; its TLS material is in the bucket)\n' ;;
    plain) printf 'executable (upstream Caddy; its certificates are on this host)\n' ;;
    *) printf 'executable\n' ;;
  esac
}

# Plain Caddy stores certificates and its ACME account in this directory.
caddy_state_note() {
  case "$MANIFEST_CADDY_FLAVOR" in
    scafo) printf 'scafo-caddy kept its certificates in the bucket, not here\n' ;;
    *) printf 'certificates and the ACME account\n' ;;
  esac
}

remove_config() {
  [ -d "$CONFIG_DIR" ] || return 0
  # Configuration includes operator-provided bucket credentials.
  remove_path "$CONFIG_DIR" 'node.env (bucket credentials) and caddy.json' || true
}

# Preserve state unless `--purge` was requested.
remove_state() {
  if [ "$PURGE" != 'yes' ]; then
    # Keep the manifest so a later `--purge` identifies created accounts.
    [ ! -d "$STATE_DIR" ] || record_kept "$STATE_DIR" 'node identity, ingress token, manifest'
    [ ! -d "$CADDY_STATE_DIR" ] || record_kept "$CADDY_STATE_DIR" "$(caddy_state_note)"
    [ ! -d "$INGRESS_LOG_DIR" ] || record_kept "$INGRESS_LOG_DIR" 'what the ingress logged'
    for user in $(users_to_remove); do
      record_kept "the \"${user}\" user" 'system account'
    done
    return 0
  fi

  remove_path "$STATE_DIR" 'node identity, ingress token, tunnel keys' || true
  remove_path "$CADDY_STATE_DIR" "$(caddy_state_note)" || true
  remove_path "$INGRESS_LOG_DIR" 'what the ingress logged' || true

  # Remove homes before accounts; remove a remaining private group if present.
  for user in $(users_to_remove); do
    if run_step "removed the \"${user}\" system user" "remove the \"${user}\" system user" \
      userdel "$user"; then
      record_removed "the \"${user}\" user" 'system account'
    else
      record_kept "the \"${user}\" user" 'userdel refused it; remove it by hand'
      continue
    fi
    if [ "$DRY_RUN" = 'no' ] && group_exists "$user"; then
      as_root groupdel "$user" >/dev/null 2>&1 || true
    fi
  done

  if [ "$MANIFEST_READ" != 'yes' ] && user_exists "$CADDY_USER"; then
    record_kept "the \"${CADDY_USER}\" user" 'may be a packaged Caddy'\''s; "userdel caddy" is yours'
  fi
}

group_exists() {
  if command -v getent >/dev/null 2>&1; then
    getent group "$1" >/dev/null 2>&1
  else
    return 1
  fi
}

report() {
  printf '\n'

  # A wrong `--bin-dir` can otherwise look like an absent installation.
  if [ -z "${REMOVED_LINES}${KEPT_LINES}" ]; then
    printf 'Nothing of scafo'\''s is on this host — no unit, no executable in %s,\n' "$BIN_DIR"
    printf 'no %s, no %s. Nothing was changed.\n\n' "$CONFIG_DIR" "$STATE_DIR"
    return 0
  fi

  if [ "$DRY_RUN" = 'yes' ]; then
    printf 'Nothing was changed. This is what %s would do.\n\n' \
      "$([ "$PURGE" = 'yes' ] && printf -- '--purge' || printf 'a plain run')"
    printf 'WOULD REMOVE\n\n'
  else
    printf 'scafo is uninstalled.\n\n'
    printf 'REMOVED\n\n'
  fi
  if [ -n "$REMOVED_LINES" ]; then
    printf '%s' "$REMOVED_LINES"
  else
    printf '  %s\n' '(nothing — this host carried none of it)'
  fi

  printf '\nKEPT\n\n'
  if [ -n "$KEPT_LINES" ]; then
    printf '%s' "$KEPT_LINES"
  else
    printf '  %s\n' '(nothing of scafo'\''s)'
  fi
  printf '  %-40s %s\n' "${BIN_DIR}/" 'the directory itself, and everything else in it'

  if [ "$PURGE" != 'yes' ] && [ -n "$KEPT_LINES" ]; then
    printf '\n  --purge removes every line above except the directory. The state one\n'
    printf '  is the one to think about: it holds the key pair this node'\''s registry\n'
    printf '  record names and the token the ingress presents to /v1/storage, and\n'
    printf '  NOTHING CAN REISSUE THEM — reinstalling over what is kept brings this\n'
    printf '  node back as itself; purging brings back a different one.\n'
  fi

  printf '\nTHE BUCKET WAS NOT TOUCHED\n\n'
  printf '  This node'\''s record, its builds and every environment it served are\n'
  printf '  where they were. That is not an omission: the registry is the FLEET'\''s,\n'
  printf '  deletion in it is gated on the coordinator lease this script does not\n'
  printf '  hold, and another node may be serving those environments right now.\n'
  printf '  THIS NODE DROPS OFF THE FLEET ON ITS OWN — stopping the daemon marked it\n'
  printf '  draining, so placement counted it out on the coordinator'\''s next pass,\n'
  printf '  and a node that never got to say so is counted out once its liveness\n'
  printf '  window runs out. Retiring what it served is "scafo env", from anywhere.\n'
  if [ "$MANIFEST_CADDY_FLAVOR" = 'scafo' ]; then
    printf '  THE TLS MATERIAL IS IN THERE TOO. This host ran scafo-caddy, so the\n'
    printf '  certificates, their keys and the ACME account were in the bucket rather\n'
    printf '  than on this disk — and every other node in the fleet is serving them\n'
    printf '  right now. Nothing here removes them, and nothing should: this host\n'
    printf '  leaving is not the certificate expiring.\n'
  fi

  printf '\nWHAT THIS COULD NOT UNDO\n\n'
  printf '  * A PATH line you added to your shell profile for %s.\n' "$BIN_DIR"
  printf '  * wireguard-tools, which install.sh never installed either — and a\n'
  printf '    tunnel that is still up: "wg-quick down wg0" is yours to run, and the\n'
  printf '    peer list in the registry still names this node until it is edited.\n'
  printf '  * A caddy, celld or esbuild that was in %s before install.sh\n' "$BIN_DIR"
  printf '    overwrote it. Those bytes were gone the moment it ran.\n'
  printf '\n'
}

# All mutations pass through these helpers so `--dry-run` remains read-only.

run_step() {
  # run_step <past tense> <infinitive> <command...>
  rs_done="$1"
  rs_would="$2"
  shift 2
  if [ "$DRY_RUN" = 'yes' ]; then
    say "would ${rs_would}"
    return 0
  fi
  if as_root "$@"; then
    say "$rs_done"
    return 0
  fi
  warn "could not ${rs_would}"
  return 1
}

# Missing paths are valid after partial or repeated uninstalls.
remove_path() {
  # remove_path <path> <note for the report>
  rp_path="$1"
  rp_note="$2"
  [ -e "$rp_path" ] || [ -L "$rp_path" ] || return 1
  safe_path "$rp_path" || {
    warn "refusing to remove \"${rp_path}\": not a path this script may delete"
    record_kept "$rp_path" 'refused: not a path this script may delete'
    return 1
  }
  if run_step "removed ${rp_path}" "remove ${rp_path}" rm -rf -- "$rp_path"; then
    record_removed "$rp_path" "$rp_note"
    return 0
  fi
  record_kept "$rp_path" 'could not be removed'
  return 1
}

# Remove optional leftovers without reporting absent paths.
remove_quietly() {
  [ -e "$1" ] || [ -L "$1" ] || return 0
  safe_path "$1" || return 0
  if [ "$DRY_RUN" = 'yes' ]; then
    say "would remove ${1}"
    return 0
  fi
  as_root rm -f -- "$1" 2>/dev/null || true
}

# Reject unsafe manifest paths before recursive removal.
safe_path() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *'..'*) return 1 ;;
  esac
  sp_rest="${1#/}"
  case "$sp_rest" in
    */*) ;;
    *) return 1 ;;
  esac
  sp_trimmed="${1%/}"
  for sp_never in $NEVER_REMOVE; do
    [ "$sp_trimmed" != "$sp_never" ] || return 1
  done
}

record_removed() {
  REMOVED_LINES="${REMOVED_LINES}$(printf '  %-40s %s' "$1" "$2")
"
}

record_kept() {
  KEPT_LINES="${KEPT_LINES}$(printf '  %-40s %s' "$1" "$2")
"
}

# Match exact words in a space-separated list.
contains() {
  for c_item in $1; do
    [ "$c_item" != "$2" ] || return 0
  done
  return 1
}

# ---------------------------------------------------------------------------

say() { printf 'scafo: %s\n' "$*" >&2; }

warn() { printf 'scafo: WARNING: %s\n' "$*" >&2; }

die() {
  printf 'scafo: %s\n' "$*" >&2
  exit 1
}

main "$@"
