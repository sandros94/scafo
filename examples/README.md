# Production Docker example

This Compose file runs one Scafo node and its Caddy ingress on one host. It does not create the registry bucket; provision an S3-compatible store that supports `If-Match` and `If-None-Match` writes before starting it.

The other recipes here put a fleet behind an ingress that is already somebody else's:

- [`k3s/`](k3s/) — a K3s or RKE2 cluster whose bundled Traefik reads the routing through its http provider, with cert-manager issuing the platform wildcard.
- [`vps/`](vps/) — two or more plain VPSs on a WireGuard mesh, each running a node and its own colocated Caddy.
- [`coolify/`](coolify/) — Coolify's Traefik proxy consumes the routing via the http provider.
- [`dokploy/`](dokploy/) — Dokploy's Traefik, same, via `traefik.yml`.

## Configure

```sh
cp .env.example .env
```

Set every blank value. `SCAFO_VERSION` pins the node image; `SCAFO_CADDY_VERSION` defaults to `edge` until a release pins both Caddy modules. Use one bucket/prefix pair only for this fleet.

Create a wildcard DNS record such as `*.apps.example.com` pointing at this host, and allow TCP 80/443 plus UDP 443. Caddy obtains ordinary certificates for each claimed hostname through HTTP-01 or TLS-ALPN; wildcard DNS does not require a wildcard certificate or DNS-provider plugin.

```sh
docker compose --env-file .env up -d
curl -s http://127.0.0.1:7400/.well-known/scafo/health
```

The node API is loopback-only. Use it for deploys or operator commands; do not publish it. Caddy shares the node network namespace and reaches it over that loopback with the ingress token (`SCAFO_INGRESS_TOKEN`, handed to Caddy as `SCAFO_FLEET_TOKEN`), never bucket credentials: it stores certificates and locks through `/v1/storage`, and polls `/v1/ingress/routes` for the fleet's routing. Its ACME account stays in the `caddy-data` volume, because it is the ingress's and not the fleet's. Caddy runs on the image's own Caddyfile, configured by environment alone, and issues on demand only for names the fleet's routing document names exactly. The node writes no ingress configuration.

Scafo publishes only claimed application hosts and the platform API apex. `/v1/storage` and everything under `/v1/ingress/routes` stay denied at that public apex — Caddy resolves no upstream for them and answers 404 itself — while the same paths on the loopback listener require the ingress token. A host nobody has claimed is answered the same way over HTTPS; there is no wildcard application fallback.

For operator routes, redirects, headers or TLS policy of your own, mount a Caddyfile over `/etc/caddy/Caddyfile`; it replaces the image's entirely. Start from scafo-ingress's [`examples/Caddyfile`](https://github.com/sandros94/scafo-ingress/blob/main/examples/Caddyfile), which is the image's default written out: a site block naming a host takes that host from its catch-alls. Nothing rewrites that file.

Keep at least 50 seconds of container stop grace. If `CELLD_SHUTDOWN_TOTAL_MS` is increased, set the grace at least 10 seconds beyond it.
