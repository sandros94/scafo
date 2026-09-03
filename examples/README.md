# Production Docker example

This Compose file runs one Scafo node and its Caddy ingress on one host. It does not create the registry bucket; provision an S3-compatible store that supports `If-Match` and `If-None-Match` writes before starting it.

## Configure

```sh
cp .env.example .env
```

Set every blank value. `SCAFO_VERSION` pins the node image; `SCAFO_CADDY_VERSION` defaults to the released `0.2.0` storage-module image. Use one bucket/prefix pair only for this fleet.

Create a wildcard DNS record such as `*.apps.example.com` pointing at this host, and allow TCP 80/443 plus UDP 443. Caddy obtains ordinary certificates for each claimed hostname through HTTP-01 or TLS-ALPN; wildcard DNS does not require a wildcard certificate or DNS-provider plugin.

```sh
docker compose --env-file .env up -d
curl -s http://127.0.0.1:7400/.well-known/scafo/health
```

The node API is loopback-only. Use it for deploys or operator commands; do not publish it. Caddy shares the node network namespace and stores certificates, ACME account material, and locks through the loopback storage API with `SCAFO_STORAGE_TOKEN`, never bucket credentials.

Scafo publishes only claimed application hosts and the platform API apex. `/v1/storage` and `/v1/ingress/traefik` remain denied at that public apex; the storage API requires its bearer token on the loopback listener.

Add independent operator routes, redirects, or TLS policy in [caddy.json](caddy.json) without using the `scafo_` route-id prefix reserved for Scafo; reconciliation preserves those routes.

Keep at least 50 seconds of container stop grace. If `CELLD_SHUTDOWN_TOTAL_MS` is increased, set the grace at least 10 seconds beyond it.
