# Scafo on plain VPSs

Two or more rented machines, no orchestrator. Each host runs one Scafo node in Docker and its own colocated `scafo-caddy`, and the hosts share a WireGuard mesh that carries node and runtime traffic. Nothing else joins them: the bucket and prefix are the fleet, and each node's tunnel record in the registry is what the next node builds its interface from.

`scafo wg init` publishes a node's public key, tunnel address and endpoint, then renders that node's `wg0.conf` from every peer that has done the same; `scafo wg peers` re-renders it later, which is how a host rolled first learns about a host rolled after it. Neither command touches the interface — bringing it up needs `NET_ADMIN` and the kernel module, so `wg-quick` is the operator's, on a file readable first.

With `SCAFO_TRANSPORT=wireguard` the node's API, its advertised address and the address runtime processes bind all default to its tunnel address. So the node API is private without being loopback-only: the colocated Caddy reaches it over the tunnel interface, a peer's Caddy reaches that host's application processes the same way, and nothing on the public interfaces answers on port 7400.

Each host's Caddy reads its certificates through its own node's `/v1/storage` and the fleet's routing from `/v1/ingress/routes` with `prefer self`, holding one ingress token and never a bucket credential. Both Caddys therefore share one certificate store in the bucket, and either can serve any host: with apex and wildcard DNS pointing at both machines, the one a request lands on serves it locally when it can and proxies to the holder over the tunnel when it cannot.

The platform domain and everything under it come from one DNS-01 wildcard, which is what the `-dns` image flavour is for. Custom domains a project claims are issued per name through on-demand TLS, gated by the node's `/v1/ingress/ask` endpoint — the fleet issues only for hosts it has been told about.

This is the multi-host recipe. For one machine use [`../compose.yaml`](../compose.yaml), or [`scripts/install.sh`](../../scripts/install.sh) for a systemd host without Docker.

## Prerequisites

- Two or more Ubuntu hosts with `docker` and `wireguard-tools` installed, and an ssh account with passwordless `sudo` on each.
- An S3-compatible bucket honouring `If-Match` / `If-None-Match` conditional writes, reachable from every host. It is not created here.
- A DNS zone whose provider is one of the ones the `-dns` image carries — bunny, cloudflare, digitalocean, hetzner, ovh, route53 — and an API credential for it. Any other provider needs [its own build](https://github.com/sandros94/scafo-ingress#a-provider-that-is-not-in-the-list).
- Apex and wildcard `A` records — `apps.example.com` and `*.apps.example.com` — pointing at every host.
- Firewall: TCP 80 and 443 plus UDP 443 open to the world, UDP 51820 open between the hosts. Port 7400 stays on the tunnel and needs no rule.

## Configure

Three things are yours to fill in.

**`.env`, beside `roll.sh`** (or anywhere, named through `ENV_FILE`). It holds the bucket credentials, the DNS credential and the fleet's shape:

```sh
# `id:address:tunnel-address[:labels]` per host, whitespace separated. The
# address is what peers send tunnel traffic to and what ssh connects to.
HOSTS="vps-a:203.0.113.10:10.83.0.1/24 vps-b:203.0.113.11:10.83.0.2/24:provider=ovh"
SSH_USER=ubuntu

DOMAIN=apps.example.com
IMAGE=ghcr.io/sandros94/scafo:0.1.0
CADDY_IMAGE=ghcr.io/sandros94/scafo-caddy:edge-dns

SCAFO_S3_ENDPOINT=
SCAFO_S3_BUCKET=
SCAFO_S3_ACCESS_KEY=
SCAFO_S3_SECRET_KEY=
SCAFO_S3_REGION=us-east-1
SCAFO_S3_PREFIX=scafo

# Variable names copied into each host's ingress.env for the Caddyfile's `dns`
# line. Their values live in this file too, and reach Caddy only.
DNS_ENV="BUNNY_API_KEY"
BUNNY_API_KEY=
```

The tunnel addresses share one `/24`; the id is the node id placement records and `scafo fleet nodes` show. Optional labels are node selectors, `key=value`.

**[`Caddyfile.tmpl`](Caddyfile.tmpl)**: the ACME contact address and the `dns` line naming the zone's provider and the variable above. `@DOMAIN@`, `@NODE@` and `@LOGS@` are filled in per host during the roll; leave them.

**Nothing else.** The ingress token is minted per host by `roll.sh` and lands in `/etc/scafo/node.env` and `/etc/scafo/ingress.env` on that host alone.

## Roll

```sh
./roll.sh
```

Per host, `roll.sh` writes the two environment files and the Caddyfile template, installs [`roll-node.sh`](roll-node.sh) as `/usr/local/bin/scafo-roll`, and runs it. That script stops the previous roll, mints a WireGuard keypair with the host's own `wg` — the image carries neither `wg` nor key material — brings the interface up from `scafo wg init`, starts the node, waits for the image's healthcheck to report `healthy`, renders the Caddyfile and starts Caddy. Afterwards `roll.sh` runs `scafo wg peers` on every host and `wg syncconf`s the result, so the hosts rolled first pick up the ones rolled last.

**A roll is destructive on the hosts it touches.** It removes the containers, `/var/lib/scafo` and `/etc/wireguard/wg0.conf`, so the node comes back with a new tunnel keypair under the same id. The registry, the applications' deployments and the certificates are in the bucket and survive it; anything else on those hosts does not.

## Verify

```sh
curl -sS https://apps.example.com/.well-known/scafo/health
curl -sS -o /dev/null -w '%{http_code}\n' https://nobody.apps.example.com/   # 404
ssh ubuntu@203.0.113.10 sudo wg show wg0
```

The health document comes from whichever host DNS resolved to; ask each address in turn with `--resolve apps.example.com:443:203.0.113.11` to see both. An unclaimed host is a 404, not a wildcard fallback: the routing document names only hosts backed by a running process. `wg show` lists the other hosts as peers, each with a recent handshake.

To deploy, reach a node's API through the tunnel from your own machine:

```sh
ssh -L 7400:10.83.0.1:7400 ubuntu@203.0.113.10
scafo remote add prod --endpoint http://127.0.0.1:7400 --register
scafo deploy ./app --project hello --env production --replicas all
curl -sS https://hello.apps.example.com/
```

`--register` records the operator key in the registry, so it reads the bucket directly and wants the same `SCAFO_S3_*` values as the nodes in that shell; everything after it goes through the node.

## Adding a host

Add its entry to `HOSTS` — a free tunnel address in the same `/24` — point its `A` records at the machine, and roll that host alone:

```sh
./roll.sh vps-c
```

Named hosts are the only ones rolled, but the peer refresh at the end runs everywhere, which is what tells the existing hosts about the new one. Placement moves environments onto it by rendezvous hashing as it joins; `--replicas all` environments start there on the next reconcile.

## Caveats

- **Caddy starts after the node is healthy, never beside it.** Caddy reads its certificate store through the node, and a name whose storage is unreachable at startup is a name Caddy gives up managing until it is restarted. The wait loop in `roll-node.sh` is the whole reason the script is sequential; the image's own healthcheck, which follows whatever listener the node's configuration resolves to, is what it waits on.
- **The Caddyfile's directory is mounted, not the file.** An editor replaces the file's inode, and a file bind mount keeps pointing at the old one, so `caddy reload` would reload a stale configuration.
- **`lb_policy first` needs `max_fails 1`.** `first` picks the first upstream not already marked down, and a dial failure marks one down only after `max_fails` failures — so with a higher count every retry returns to the same dead process and the request fails before the mark is ever set.
- **A node's ingress token is that node's.** It authorizes that node's storage and routing APIs only; `roll.sh` mints a fresh one per host per roll, and rolling one host does not disturb another's.
- **One bucket and prefix is one fleet.** Bucket credentials are fleet-root authority and live in `/etc/scafo/node.env`, mode `0700` and root-owned, never in Caddy's environment.
- **Allow 50 seconds of stop grace.** `--stop-timeout 50` covers node drain plus the runtime's shutdown bound; raise it past `CELLD_SHUTDOWN_TOTAL_MS + 10s` if that is increased.
