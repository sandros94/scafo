# Scafo on Dokploy

A Dokploy server already runs Traefik in front of everything it deploys. This example makes that Traefik the fleet's ingress too: the Scafo node runs beside Dokploy's own resources as an ordinary Compose service, and `dokploy-traefik` polls `/v1/ingress/routes/traefik` on it. Scafo writes no proxy configuration; the provider block below is yours, in Dokploy's file, and nothing rewrites it.

Scafo's routers arrive as `scafo_<host>@http`. Dokploy's own routers stay in its Docker, Swarm and file providers and are untouched.

## Prerequisites

- Dokploy running Traefik v3.6 or newer (`TRAEFIK_VERSION`). Traefik v3 has `providers.http.headers`, which is how the ingress token is presented; v2 cannot.
- An external S3-compatible store honouring `If-Match` / `If-None-Match` conditional writes. Provision it before starting the node; Compose does not create it.
- A wildcard DNS record such as `*.apps.example.com`, plus the apex, pointing at this server.
- An ingress token: `openssl rand -base64 32`.

## Run the node

[compose.yaml](compose.yaml) is the node. Deploy it as a Dokploy **Compose** service, or run it on the host with `docker compose`; either way it joins `dokploy-network`, which Traefik is already on, and it publishes nothing to the internet.

The values it needs are the ones in [../.env.example](../.env.example), minus `SCAFO_CADDY_VERSION`: this recipe has no Caddy.

```sh
cp ../.env.example .env
docker compose --env-file .env up -d
curl -s http://127.0.0.1:7400/.well-known/scafo/health
```

`SCAFO_TRANSPORT=none` states that `dokploy-network` is private and trusted. With it, the runtime processes the node supervises bind every interface of the container, so Traefik can dial them. `SCAFO_ADVERTISE=scafo-node:7400` is the name the fleet's routing publishes for this node and for each process port; the network alias in the Compose file is what makes that name resolve regardless of how Dokploy names the container. The node API is also published on host loopback, for `scafo` deploy and operator commands only.

## Teach Traefik

Dokploy bind-mounts Traefik's static configuration from `/etc/dokploy/traefik/traefik.yml`. Open it under Traefik File System in the UI, or edit it on disk, and merge the `http` provider from [traefik.providers.yml](traefik.providers.yml) into the `providers` mapping that is already there, replacing `<SCAFO_INGRESS_TOKEN>` with the token.

Static configuration is not hot-reloaded, so apply it with Traefik's Reload action in the UI or with `docker restart dokploy-traefik`. Only the routing itself is dynamic, on Traefik's five-second poll.

Nothing else needs changing. Dokploy's `websecure` entryPoint already carries `http.tls.certResolver: letsencrypt`, which is what `SCAFO_TRAEFIK_ENTRYPOINTS=websecure` in the Compose file relies on: Scafo's routers carry no TLS block, and the entryPoint terminates for them as it does for Dokploy's own.

## Verify

```sh
docker logs dokploy-traefik 2>&1 | grep -i "provider.*http"
curl -s -H "Authorization: Bearer $SCAFO_INGRESS_TOKEN" \
  "http://127.0.0.1:7400/v1/ingress/routes/traefik?prefer=self"
curl -sk --resolve apps.example.com:443:127.0.0.1 \
  https://apps.example.com/.well-known/scafo/health
```

`prefer=self` is right here because Traefik and the node share a machine: this node's upstreams are used while they are healthy, and the fleet's other nodes only when they are not. On a single-node fleet it changes nothing and stays correct as the fleet grows.

A deployed environment answers at its own host the same way. Until then only the platform apex is routed: Scafo publishes no wildcard application fallback, and an unclaimed host is a 404 at the proxy.

## Certificates

Dokploy's `letsencrypt` resolver is HTTP-01 on the `web` entryPoint, storing to `/etc/dokploy/traefik/dynamic/acme.json`. The platform domain therefore gets an ordinary certificate per host, issued on the first request for that host — there is no wildcard certificate, and none is needed. A custom domain an environment claimed is issued the same way once its DNS points at this server. DNS-01, for a real wildcard, would need a second resolver and its provider credentials in the same static file.

## Caveats

- The ingress token sits in plain text in `/etc/dokploy/traefik/traefik.yml`, readable by anyone with the Dokploy UI or the server. A Traefik provider is static configuration, so there is no dynamic file and no environment indirection to put it behind; this is the cost of the http provider on this platform.
- The token is nonetheless the only credential Traefik holds. It never sees bucket credentials, which are fleet-root authority.
- Every edit to the static file needs the reload above. Forgetting it leaves Traefik running the previous configuration with no error.
- Keep at least 50 seconds of container stop grace. If `CELLD_SHUTDOWN_TOTAL_MS` is increased, set the grace at least 10 seconds beyond it.
