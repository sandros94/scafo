# Production Docker example

This Compose file runs one Scafo node and its Caddy ingress on one host. It does not create the registry bucket; provision an S3-compatible store that supports `If-Match` and `If-None-Match` writes before starting it.

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

The node API is loopback-only. Use it for deploys or operator commands; do not publish it. Caddy shares the node network namespace and reaches it over that loopback with the ingress token (`SCAFO_INGRESS_TOKEN`), never bucket credentials: it stores certificates, ACME account material, and locks through `/v1/storage`, and polls `/v1/ingress/routes` for the fleet's routing. The node writes no ingress configuration; [caddy.json](caddy.json) is yours.

Scafo publishes only claimed application hosts and the platform API apex. `/v1/storage` and everything under `/v1/ingress/routes` stay denied at that public apex — Caddy resolves no upstream for them and the error route answers 404 — while the same paths on the loopback listener require the ingress token. A host nobody has claimed is answered the same way; there is no wildcard application fallback.

Add independent operator routes, redirects, or TLS policy in [caddy.json](caddy.json) ahead of the dynamic-upstreams catch-all. Nothing rewrites that file, so a route that matches first always wins.

Keep at least 50 seconds of container stop grace. If `CELLD_SHUTDOWN_TOTAL_MS` is increased, set the grace at least 10 seconds beyond it.
