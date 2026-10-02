#!/bin/sh
# Celld, unless the end-to-end suite has said that one application's process on
# this node must exit before it becomes ready.
#
# A node is pointed here through `SCAFO_CELLD_BIN`, so every Celld this node runs
# goes through it: the version probe at boot and `celld deploy` carry no
# `CELLD_WATCH` and are handed straight on. A supervised process carries the work
# directory scafo derives for its application, `<state dir>/celld/<application>/work`,
# which is how the application is told apart without parsing any argument.
#
# The marker is a file named after the application under REFUSE_DIR, inside the
# node's container: present, the process says so on stderr and exits 1, the way
# a runtime that cannot get going does; absent, it is the real Celld.

REFUSE_DIR=/tmp/scafo-e2e-refuse

case "${CELLD_WATCH:-}" in
  */celld/*/work)
    application=${CELLD_WATCH%/work}
    application=${application##*/}
    if [ -e "$REFUSE_DIR/$application" ]; then
      echo "e2e: refusing to start celld for $application" >&2
      exit 1
    fi
    ;;
esac

exec /usr/local/bin/celld "$@"
