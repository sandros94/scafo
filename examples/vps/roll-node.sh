#!/bin/sh
# Rolls one Scafo node on this VPS: wipes the previous roll, brings the tunnel
# up from freshly minted keys, starts the node and its colocated ingress.
# Expects /etc/scafo/node.env (node settings and bucket credentials),
# /etc/scafo/ingress.env (the ingress token and any DNS-01 credential) and
# /etc/scafo/Caddyfile.template in place, and WG_ADDRESS, IMAGE, CADDY_IMAGE and
# DOMAIN in the environment. `roll.sh` puts all of that here.
set -eu

: "${WG_ADDRESS:?}" "${IMAGE:?}" "${CADDY_IMAGE:?}" "${DOMAIN:?}"
STATE=/var/lib/scafo
LOGS=/var/log/scafo-ingress

echo "== stop the previous roll"
docker rm -f scafo-node scafo-caddy >/dev/null 2>&1 || true
wg-quick down wg0 >/dev/null 2>&1 || true
# The tunnel material is the only thing a roll mints again. THE REST OF THE
# STATE DIRECTORY STAYS: each supervised runtime process keeps its work
# directory under it, and that directory is the local half of the fleet's
# durability — a write is acknowledged once a peer holds it there, before the
# bucket has it, and the process recovers it at boot from the directory its
# predecessor of the same node name left. Removing it loses those writes.
rm -f "$STATE/wg-private.key" "$STATE/wg-public.key" /etc/wireguard/wg0.conf
# The image runs as uid 10001 and both directories are written from inside it.
install -d -m 0700 "$STATE" && chown 10001:10001 "$STATE"
install -d -m 0755 "$LOGS" && chown 10001:10001 "$LOGS"

echo "== mint tunnel keys"
# The image carries no `wg`, and Scafo never invents key material: the keypair
# is made here, in the state directory the node reads it from.
umask 077
wg genkey >"$STATE/wg-private.key"
wg pubkey <"$STATE/wg-private.key" >"$STATE/wg-public.key"
chown 10001:10001 "$STATE"/wg-*.key

echo "== pull images"
# An image no registry has — built here, or loaded with `docker load` — is used as
# it stands; anything else that cannot be pulled and is not present stops the roll.
for image in "$IMAGE" "$CADDY_IMAGE"; do
  docker pull -q "$image" || docker image inspect "$image" >/dev/null
done

echo "== scafo wg init"
# Publishes this node's public key and endpoint in the registry and renders an
# interface from every peer that has done the same. Bringing it up is ours.
docker run --rm --network host --env-file /etc/scafo/node.env \
  -v "$STATE:$STATE" "$IMAGE" wg init \
  --stdout >/etc/wireguard/wg0.conf
chmod 600 /etc/wireguard/wg0.conf
wg-quick up wg0

# With the WireGuard transport the node binds its tunnel address, and advertises
# it to peers; the ingress reaches it there and nowhere public.
WG_HOST="${WG_ADDRESS%/*}"
echo "== start the node"
docker run -d --name scafo-node --restart unless-stopped --stop-timeout 50 \
  --network host --env-file /etc/scafo/node.env \
  -v "$STATE:$STATE" -v "$LOGS:$LOGS" "$IMAGE" sail >/dev/null

echo "== wait for the node (Caddy reads its certificates through it at boot)"
until [ "$(docker inspect -f '{{.State.Health.Status}}' scafo-node)" = healthy ]; do sleep 2; done

echo "== start Caddy"
# The directory is mounted, not the file: an edited file is a new inode, which
# a file bind mount keeps pointing past, so `caddy reload` would reload the old.
install -d -m 0755 /etc/scafo/caddy
sed "s/@DOMAIN@/$DOMAIN/g; s/@NODE@/$WG_HOST:7400/g; s#@LOGS@#$LOGS#g" \
  /etc/scafo/Caddyfile.template >/etc/scafo/caddy/Caddyfile
docker run -d --name scafo-caddy --restart unless-stopped --network host \
  --env-file /etc/scafo/ingress.env \
  -v /etc/scafo/caddy:/etc/caddy:ro \
  -v scafo-caddy-data:/data -v "$LOGS:$LOGS" "$CADDY_IMAGE" >/dev/null
echo "== rolled"
