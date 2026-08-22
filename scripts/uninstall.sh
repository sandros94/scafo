#!/bin/sh
#
# scafo — the inverse of scripts/install.sh.
#
#   sh uninstall.sh              # stop it, remove it, KEEP this node's identity
#   sh uninstall.sh --purge      # the identity, the certificates and the users too
#   sh uninstall.sh --dry-run    # print what either of those would do, change nothing
#
# It takes the host apart in the order it was put together, backwards: the
# ingress is stopped before the node — nothing must be routed to processes that
# are about to stop — the node is then given the whole 40s its unit allows it to
# drain in, and only once both are down are the units, the executables and the
# configuration removed.
#
# WHAT IT KEEPS, AND WHY THAT IS THE DEFAULT
#
#   /var/lib/scafo is this node's IDENTITY: the Ed25519 pair its registry record
#   names, the storage token the ingress presents to /v1/storage, and the
#   WireGuard keys if it is on a tunnel. NOTHING CAN REISSUE THEM — a node that
#   lost them comes back as a different node and leaves its old public key behind
#   in the registry. So a plain run leaves the directory exactly where it is,
#   says so at the end, and names the flag that removes it. Same for the
#   ingress's certificates and its ACME account under /var/lib/caddy, which are
#   rate-limited to reissue, and for whatever Caddy logged.
#
# WHAT IT NEVER TOUCHES: THE BUCKET
#
#   The registry belongs to the FLEET and not to this host, and an uninstall is
#   in no position to edit it: it holds no coordinator lease, deletion in that
#   registry is lease-gated for exactly that reason, and another node may be
#   serving these very environments right now. A departed node needs no cleanup
#   anyway — stopping the agent makes it mark itself draining, which counts it
#   out of placement on the coordinator's next pass, and a node that never got to
#   say so is counted out once the liveness window runs out. Its record is inert
#   either way. Removing a project, an environment or a build is `scafo env` and
#   the reaper, deliberately, and never a script that is taking one host apart.
#
# WHAT IT CANNOT UNDO, and says so at the end rather than pretending otherwise:
# the bin directory itself (it may have been created for this install, and it
# holds everything else on the host too), a PATH line an operator added to their
# own shell profile, the wireguard-tools their package manager installed, a
# tunnel interface that is still up, and an /etc/systemd/system/caddy.service
# that was SHADOWING a distribution's own Caddy unit — removing it hands that
# host back its packaged Caddy, which is right, and is worth knowing.
#
# WHAT IT READS FROM THE ENVIRONMENT
#
#   SCAFO_INSTALL_BIN_DIR  where the executables were installed. The same name
#                          install.sh reads, so a non-default install is undone
#                          by repeating it. Also --bin-dir.
#
# HOW IT KNOWS WHAT TO REMOVE: /var/lib/scafo/install.manifest, written by
# install.sh, which carries the two things that cannot be derived from anywhere
# else — which directory the executables went into, and which of the two system
# accounts that run CREATED rather than found. Without it (a host installed
# before it existed, or a state directory already gone) everything below is
# derived instead: the installer's own defaults, the ExecStart of the unit it
# wrote, and finally whatever `scafo` is on PATH. The manifest makes it exact;
# its absence makes it careful.

set -eu

# ---------------------------------------------------------------------------
# WHAT INSTALL.SH MADE.
#
# THIS LIST AND scripts/install.sh's CONSTANTS ARE ONE LIST IN TWO FILES AND
# MUST CHANGE TOGETHER. A unit, a directory, a system user or a binary added
# there and not here is one this script silently leaves on every host it is run
# on — and the failure is invisible, because an uninstall that removes four of
# five things still ends by reporting success. The manifest carries the parts
# that cannot be derived; these constants are what a host without one is held
# to, so both have to stay true.

STATE_DIR='/var/lib/scafo'
CONFIG_DIR='/etc/scafo'
INGRESS_LOG_DIR='/var/log/scafo-ingress'
# Caddy's own state: `StateDirectory=caddy` in the unit creates it, useradd names
# it as the home of the account, and XDG_DATA_HOME/XDG_CONFIG_HOME point the
# certificates and the ACME account at it.
CADDY_STATE_DIR='/var/lib/caddy'
SERVICE_USER='scafo'
CADDY_USER='caddy'

UNIT_DIR='/etc/systemd/system'
NODE_UNIT='scafo-node.service'
# install.sh names the ingress unit after the account it runs as.
INGRESS_UNIT='caddy.service'

# The four executables one scafo node is made of, in install.sh's order.
BINARIES='scafo celld caddy esbuild'

MANIFEST_NAME='install.manifest'

# Directories that are never a removal target whatever a manifest says, because
# every one of them belongs to the host rather than to this install.
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
                    identity and the storage token, which nothing can reissue),
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

# ---------------------------------------------------------------------------
# Privilege
#
# The same model install.sh uses, for the same reason: root, or PASSWORDLESS
# sudo — the only kind worth testing for in a script meant to be readable from a
# pipe, which has no terminal to prompt on — or neither.

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

# Where install.sh could fall back to ~/.local/bin and still install something
# whole, this cannot: HALF AN UNINSTALL IS WORSE THAN NONE. A run that removed
# the binaries and could not stop the units leaves a host whose systemd keeps
# restarting an ExecStart that no longer exists, and reports a clean removal
# while doing it. So the moment the survey found anything root-owned, an
# unprivileged run stops here and names all of it. A user-local install — the one
# install.sh makes in ~/.local/bin without root — has none of that, and is undone
# by the same command without any privilege at all.
require_privilege() {
  [ -n "$ROOT_WORK" ] || return 0
  [ "$(id -u)" -ne 0 ] || return 0
  [ -z "$SUDO" ] || return 0

  # A dry run removes nothing, so there is nothing to be unprivileged FOR. It is
  # allowed through — reading a plan is exactly what an operator does before
  # deciding to sudo — and told that the real run will need root.
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

# ---------------------------------------------------------------------------
# What is on this host

# The record install.sh leaves under the state directory. Every field is
# optional: this reads what is there and derives the rest, so a host installed
# before the manifest existed uninstalls exactly as one installed after it.
read_manifest() {
  MANIFEST_BIN_DIR=''
  MANIFEST_BINARIES=''
  MANIFEST_UNITS=''
  MANIFEST_CREATED_USERS=''
  MANIFEST_CONFIG_DIR=''
  MANIFEST_INGRESS_LOG_DIR=''
  MANIFEST_CADDY_STATE_DIR=''
  manifest="${STATE_DIR}/${MANIFEST_NAME}"

  [ -f "$manifest" ] || return 0
  [ -r "$manifest" ] || {
    warn "${manifest} is not readable by this user; deriving what to remove instead"
    return 0
  }

  # The `|| [ -n "$line" ]` is for a manifest whose last line lost its newline to
  # an editor: without it that line is read and then dropped.
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
      *) ;;
    esac
  done < "$manifest"

  MANIFEST_READ='yes'
  say "read ${manifest}"

  # What the installer SAYS it made outranks what this script assumes it did, so
  # that an edit to install.sh's constants is followed here without a second
  # edit. No `state_dir=`: this file was found inside it, and a manifest naming
  # a directory other than the one it is in is describing a different install.
  adopt "$MANIFEST_CONFIG_DIR" && CONFIG_DIR="$MANIFEST_CONFIG_DIR"
  adopt "$MANIFEST_INGRESS_LOG_DIR" && INGRESS_LOG_DIR="$MANIFEST_INGRESS_LOG_DIR"
  adopt "$MANIFEST_CADDY_STATE_DIR" && CADDY_STATE_DIR="$MANIFEST_CADDY_STATE_DIR"
  return 0
}

# Whether a path out of the manifest may replace a constant: present, and one
# this script would be allowed to remove in the first place.
adopt() {
  [ -n "$1" ] || return 1
  safe_path "$1" || {
    warn "ignoring \"${1}\" from the manifest: not a path this script may remove"
    return 1
  }
}

# Four answers, best first. The manifest is exact; the unit's ExecStart is the
# next best thing and is what a host installed before the manifest existed still
# has written down; SCAFO_INSTALL_BIN_DIR repeats what the operator told the
# installer; and `scafo` on PATH is the last resort. Failing all of it, the same
# default install.sh would have picked for this user.
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
  # `ExecStart=/usr/local/bin/scafo up` -> /usr/local/bin
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

# Read-only. Everything this script will and will not remove is decided here,
# BEFORE anything is stopped or deleted, so that an unprivileged run can be
# refused while the host is still whole.
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

# Which system accounts --purge may delete, and the asymmetry is deliberate.
#
# With a manifest, exactly the ones THIS install created: an account it merely
# found stays, because a "caddy" a distribution's package made owns a Caddy this
# script knows nothing about. Without one, the same rule is enforced by evidence
# instead — "scafo" is deleted only when its home is the state directory
# install.sh gave it, which nothing else on a host does, and "caddy" is never
# deleted at all, because there is no way to tell one apart from a packaged one
# and leaving an unused account behind is the cheaper mistake. The final report
# prints the command for it.
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

# ---------------------------------------------------------------------------
# Taking it down

# INGRESS FIRST, NODE SECOND — the reverse of the order install.sh writes them
# in. Stopping Caddy first means nothing is routed to runtime processes that are
# about to stop; stopping the node first would leave an ingress answering for
# addresses that are draining out from under it.
#
# And the node is given its time. Its unit allows 40s between SIGTERM and
# SIGKILL because the agent marks itself draining, releases the coordinator
# lease, stops reconciling, closes its listener and only THEN drains each
# runtime process for 25s. `systemctl stop` waits for all of it, which is the
# point: a node that gets to finish tells the fleet it is leaving, and one that
# is killed has to be timed out over the liveness window instead.
stop_units() {
  have_systemd || return 0

  for unit in $INGRESS_UNIT $NODE_UNIT; do
    contains "$FOUND_UNITS" "$unit" || continue

    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      if [ "$unit" = "$NODE_UNIT" ]; then
        say 'the node drains its runtimes on the way out — this takes up to 40s'
      fi
      run_step "stopped ${unit}" "stop ${unit}" systemctl stop "$unit" || true
    fi

    if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
      run_step "disabled ${unit}" "disable ${unit}" systemctl disable "$unit" || true
    fi

    # Clears a unit left in the failed state, so a host that keeps its systemd
    # around does not carry the ghost of a service that no longer exists.
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
      # Removing this file unshadows a distribution's own caddy.service, if the
      # host has one. That is correct — it was never ours to keep hidden.
      note='systemd unit (a packaged caddy.service, if any, applies again)'
    fi
    remove_path "${UNIT_DIR}/${unit}" "$note" && removed_any='yes'

    # What `systemctl enable` created. Removed explicitly because a host whose
    # systemd is not running never got the `disable` above, and a dangling
    # symlink into a unit file that is gone is a boot-time warning forever.
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

# The four executables, and only from the directory this install used. They are
# removed by NAME — `caddy`, `celld` and `esbuild` are names an operator may also
# have had there, and install.sh overwrote whatever it found, which is a thing
# neither script can undo. The manifest is what makes this exact on hosts that
# have one.
remove_binaries() {
  for name in $FOUND_BINARIES; do
    remove_path "${BIN_DIR}/${name}" 'executable' || true
  done
}

remove_config() {
  [ -d "$CONFIG_DIR" ] || return 0
  # node.env holds the bucket credentials an operator wrote into it. It goes:
  # they are the operator's to keep elsewhere, and they say nothing this host
  # cannot be told again — unlike the state directory, which holds the one thing
  # that cannot be reissued.
  remove_path "$CONFIG_DIR" 'node.env (bucket credentials) and caddy.json' || true
}

# The identity, the certificates, the logs and the accounts. All of it is kept
# unless --purge says otherwise, and every line of it is named in the report
# either way.
remove_state() {
  if [ "$PURGE" != 'yes' ]; then
    # The manifest is kept with it ON PURPOSE: a --purge run days later still has
    # to know which system accounts THIS install created.
    [ ! -d "$STATE_DIR" ] || record_kept "$STATE_DIR" 'node identity, storage token, manifest'
    [ ! -d "$CADDY_STATE_DIR" ] || record_kept "$CADDY_STATE_DIR" 'certificates and the ACME account'
    [ ! -d "$INGRESS_LOG_DIR" ] || record_kept "$INGRESS_LOG_DIR" 'what the ingress logged'
    for user in $(users_to_remove); do
      record_kept "the \"${user}\" user" 'system account'
    done
    return 0
  fi

  remove_path "$STATE_DIR" 'node identity, storage token, tunnel keys' || true
  remove_path "$CADDY_STATE_DIR" 'certificates and the ACME account' || true
  remove_path "$INGRESS_LOG_DIR" 'what the ingress logged' || true

  # After the directories, so that userdel never has to reason about a home it
  # still owns. A user's private group goes with it on every distribution that
  # made one; the groupdel is for the ones that did not.
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

# ---------------------------------------------------------------------------
# What happened

report() {
  printf '\n'

  # A host that carried none of this is told so and left alone: every section
  # below is about an install, and there was not one here. Says where it looked,
  # because a wrong --bin-dir looks exactly like this.
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
  printf '  %-30s %s\n' "${BIN_DIR}/" 'the directory itself, and everything else in it'

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
  printf '  THIS NODE DROPS OFF THE FLEET ON ITS OWN — stopping the agent marked it\n'
  printf '  draining, so placement counted it out on the coordinator'\''s next pass,\n'
  printf '  and a node that never got to say so is counted out once its liveness\n'
  printf '  window runs out. Retiring what it served is "scafo env", from anywhere.\n'

  printf '\nWHAT THIS COULD NOT UNDO\n\n'
  printf '  * A PATH line you added to your shell profile for %s.\n' "$BIN_DIR"
  printf '  * wireguard-tools, which install.sh never installed either — and a\n'
  printf '    tunnel that is still up: "wg-quick down wg0" is yours to run, and the\n'
  printf '    peer list in the registry still names this node until it is edited.\n'
  printf '  * A caddy, celld or esbuild that was in %s before install.sh\n' "$BIN_DIR"
  printf '    overwrote it. Those bytes were gone the moment it ran.\n'
  printf '\n'
}

# ---------------------------------------------------------------------------
# Removing things, or saying what would be removed
#
# EVERY MUTATION IN THIS SCRIPT GOES THROUGH run_step OR remove_path, WHICH IS
# WHAT MAKES --dry-run TOTAL rather than a best effort: nothing else here
# removes, signals or writes anything.

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

# Removes one path and records it, or records why it stayed. A path that is not
# there is not an error — this script has to survive a host where install.sh
# half-ran, never ran, or where it has already run once.
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

# For the leftovers nobody needs told about — a wants symlink, and anything else
# whose absence is the normal case.
remove_quietly() {
  [ -e "$1" ] || [ -L "$1" ] || return 0
  safe_path "$1" || return 0
  if [ "$DRY_RUN" = 'yes' ]; then
    say "would remove ${1}"
    return 0
  fi
  as_root rm -f -- "$1" 2>/dev/null || true
}

# The whole of what stands between a hand-edited manifest and `rm -rf /`: an
# absolute path, of at least two components, that is not one of the host's own
# directories.
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
  REMOVED_LINES="${REMOVED_LINES}$(printf '  %-30s %s' "$1" "$2")
"
}

record_kept() {
  KEPT_LINES="${KEPT_LINES}$(printf '  %-30s %s' "$1" "$2")
"
}

# Whether a space-separated list holds an exact word.
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
