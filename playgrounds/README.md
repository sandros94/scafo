# Playgrounds

Two disposable local Scafo installations. They use the node image, ingress, deploy path, and a SeaweedFS S3-compatible registry store; no cloud account or DNS is required.

- [`single-node/`](single-node/README.md) — register, deploy, route, replace, and observe an application.
- [`multi-node/`](multi-node/README.md) — inspect coordination, placement, cell ownership, and draining.

## Cleanup

Each playground uses its own Docker volumes plus two local paths:

```sh
docker compose down -v
rm -rf .env .scafo
```

`.scafo/` is a playground-local `SCAFO_HOME`; no system service is installed.

## Who a fleet trusts

Bucket credentials are fleet-root authority. Trust keys with `--register` for bootstrap/recovery or through an admin-authenticated node API. Admins manage the fleet's keys; operators can grant no higher tier and revoke only their replacement lineage.

Operator-tier keys require application scope, given by `--apps` when the key is enrolled over the wire. The flag repeats, one entry each: an exact application name, a prefix glob such as `shop-*`, or `*`; `--apps "*"` grants every application and requires an admin. Keep bucket credentials out of tenant workflows.

Scoped callers see only their key lineage and reachable applications.

## Prerequisites

Docker with Compose v2.

```sh
docker pull ghcr.io/sandros94/scafo:latest
docker pull ghcr.io/sandros94/scafo-caddy:0.2.1
```

Each playground uses the released node image and the released Caddy image. Set `SCAFO_IMAGE` or `SCAFO_CADDY_IMAGE` in `.env` to test local images. The walkthroughs use the container CLI; a built checkout remains an optional alternative.

The Caddy image includes `caddy.storage.scafo` for TLS material and the `scafo` dynamic-upstreams module for routing. Both read the node's loopback API with the ingress token; neither holds bucket credentials.

## Scope

[`../examples/`](../examples/) contains production-shaped Compose and Kubernetes configurations. Playgrounds use fake credentials, local bucket containers, and overridable ports. Both retain the 50-second stop grace, shared ingress/node namespace, and one-bucket-prefix-per-fleet boundary.

The playgrounds use plain HTTP because `*.scafo.test` has no DNS or certificate authority. They omit custom domains and CI deploys.
