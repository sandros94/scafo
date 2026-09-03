#!/bin/bash
# Rolls a Scafo fleet of plain VPSs over ssh: per host it writes the node and
# ingress environment, ships the Caddyfile template and `roll-node.sh`, and runs
# that script there; afterwards it re-renders every host's WireGuard peers, so
# the hosts rolled last are known to the ones rolled first.
#
#   ./roll.sh            # every host in HOSTS
#   ./roll.sh vps-c      # only that host, peers refreshed everywhere
#
# Settings come from ENV_FILE, `.env` beside this script by default. See
# README.md for the keys and for what a roll destroys.
set -eu

here=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1090 # the operator's own file, named at run time
set -a && . "${ENV_FILE:-$here/.env}" && set +a

: "${HOSTS:?set HOSTS in the env file}"
: "${DOMAIN:?set DOMAIN in the env file}"
: "${IMAGE:?set IMAGE in the env file}"
: "${CADDY_IMAGE:?set CADDY_IMAGE in the env file}"
: "${SCAFO_S3_ENDPOINT:?}" "${SCAFO_S3_BUCKET:?}"
: "${SCAFO_S3_ACCESS_KEY:?}" "${SCAFO_S3_SECRET_KEY:?}"

SSH_USER=${SSH_USER:-ubuntu}

roll() {
  local id=$1 addr=$2 wg=$3 labels=$4 token ingress
  # One ingress token per host: it authorizes this node's storage and routing
  # APIs only, so a host's token is worth nothing on another host.
  token=$(openssl rand -hex 32)
  echo "#### rolling $id ($addr)"

  # shellcheck disable=SC2087 # the here document is this shell's values, deliberately
  ssh -o BatchMode=yes "$SSH_USER@$addr" \
    "sudo install -d -m 0700 /etc/scafo && sudo tee /etc/scafo/node.env >/dev/null" <<EOF
SCAFO_S3_ENDPOINT=$SCAFO_S3_ENDPOINT
SCAFO_S3_REGION=${SCAFO_S3_REGION:-us-east-1}
SCAFO_S3_BUCKET=$SCAFO_S3_BUCKET
SCAFO_S3_ACCESS_KEY=$SCAFO_S3_ACCESS_KEY
SCAFO_S3_SECRET_KEY=$SCAFO_S3_SECRET_KEY
SCAFO_S3_PREFIX=${SCAFO_S3_PREFIX:-scafo}
SCAFO_PLATFORM_DOMAINS=$DOMAIN
SCAFO_NODE_ID=$id
${labels:+SCAFO_NODE_LABELS=$labels}
SCAFO_TRANSPORT=wireguard
SCAFO_WG_ADDRESS=$wg
SCAFO_WG_ENDPOINT=$addr:51820
SCAFO_INGRESS_TOKEN=$token
SCAFO_OBSERVABILITY=1
SCAFO_INGRESS_ACCESS_LOG=/var/log/scafo-ingress/access.log
EOF

  # The DNS-01 credential is Caddy's alone; the node never needs it, and the
  # bucket credentials above never reach Caddy.
  ingress=$(
    printf 'SCAFO_INGRESS_TOKEN=%s\n' "$token"
    # shellcheck disable=SC2086 # DNS_ENV is a list of variable names
    for var in ${DNS_ENV:-}; do
      printf '%s=%s\n' "$var" "${!var:?set $var in the env file}"
    done
  )
  printf '%s\n' "$ingress" |
    ssh -o BatchMode=yes "$SSH_USER@$addr" "sudo tee /etc/scafo/ingress.env >/dev/null"

  ssh -o BatchMode=yes "$SSH_USER@$addr" \
    "sudo tee /etc/scafo/Caddyfile.tmpl >/dev/null" <"$here/Caddyfile.tmpl"
  ssh -o BatchMode=yes "$SSH_USER@$addr" \
    "sudo tee /usr/local/bin/scafo-roll >/dev/null && sudo chmod +x /usr/local/bin/scafo-roll" \
    <"$here/roll-node.sh"
  ssh -o BatchMode=yes "$SSH_USER@$addr" \
    "sudo env WG_ADDRESS=$wg IMAGE=$IMAGE CADDY_IMAGE=$CADDY_IMAGE DOMAIN=$DOMAIN scafo-roll"
}

# Every node publishes its public key and endpoint in the registry, so this is a
# read of what is registered now, not an exchange between the hosts.
peers() {
  local id=$1 addr=$2
  echo "#### peers on $id"
  ssh -o BatchMode=yes "$SSH_USER@$addr" "sudo docker run --rm --network host \
    --env-file /etc/scafo/node.env -v /var/lib/scafo:/var/lib/scafo $IMAGE wg peers --stdout \
    | sudo tee /etc/wireguard/wg0.conf >/dev/null \
    && sudo bash -c 'wg syncconf wg0 <(wg-quick strip wg0)' && sudo wg show wg0 peers"
}

# No arguments means the whole fleet; naming hosts rolls those alone.
selected() {
  local id=$1 wanted
  shift
  if [ "$#" -eq 0 ]; then return 0; fi
  for wanted in "$@"; do
    if [ "$wanted" = "$id" ]; then return 0; fi
  done
  return 1
}

# A typo in an argument would otherwise roll nothing and say so with silence.
for wanted in "$@"; do
  case " $HOSTS " in
    *" $wanted:"*) ;;
    *)
      echo "roll.sh: no host \"$wanted\" in HOSTS" >&2
      exit 1
      ;;
  esac
done

# An entry is `id:address:tunnel-address[:labels]`; the address is what peers
# and this script both reach the host at.
for entry in $HOSTS; do
  IFS=: read -r id addr wg labels <<<"$entry"
  : "${id:?malformed HOSTS entry: $entry}" "${addr:?}" "${wg:?}"
  if ! selected "$id" "$@"; then continue; fi
  roll "$id" "$addr" "$wg" "${labels:-}"
done

for entry in $HOSTS; do
  IFS=: read -r id addr _ <<<"$entry"
  peers "$id" "$addr"
done
