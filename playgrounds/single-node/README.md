# The single-node playground

One bucket, one Scafo node, one ingress, thrown away when you are done. This walkthrough registers a remote, deploys an application, reaches it by name, then replaces its current deployment. Start with [`../README.md`](../README.md).

## 0. Ports

| Port   | What                    | Bound to        |
| ------ | ----------------------- | --------------- |
| `80`   | Application ingress     | every interface |
| `7400` | Scafo node/API listener | `127.0.0.1`     |
| `8333` | Bucket                  | `127.0.0.1`     |

Port 80 is usually the taken one. Move any port in `.env` when needed.

## 1. Start the stack

```sh
cp .env.example .env
docker compose up -d
docker compose logs node
curl -s http://127.0.0.1:7400/.well-known/scafo/health
```

The `bucket` container exits successfully after creating the bucket. The node then reports its id and the coordinator lease. The health document describes the Scafo daemon only; it does not say that an application is deployed.

## 2. Point your shell at it

```sh
export SCAFO_HOME="$PWD/.scafo"
set -a; . ./.env; set +a
alias scafo='docker compose run --rm cli'
```

`SCAFO_HOME` keeps the playground's keys and remotes out of your real `~/.scafo`. The container CLI reaches the node at `http://node:7400`, so use that endpoint in the next step. To use a built checkout instead:

```sh
alias scafo='node ../../dist/cli/index.mjs'
```

Use `http://127.0.0.1:7400` with the local CLI alias.

## 3. Register the remote

```sh
scafo remote add playground --endpoint http://node:7400 --register
scafo remote list
```

This mints an admin-tier operator key under `.scafo/` and registers its public half in the shared registry. Later commands resolve the only remote automatically.

## 4. Deploy the application

`app/` contains a small Worker with `/` and a durable `/count` endpoint. Its [`wrangler.jsonc`](app/wrangler.jsonc) names it `shop`, which is the application the deploy creates and the name it is served under; `--name` overrides that, and `--env preview` would address `shop-preview` instead.

```sh
scafo deploy ./app
```

The command progresses through `accepted`, `uploading`, and `deployed`, then prints the immutable build id recorded by Scafo. Celld publishes that deployment as the application's current one; no activation flag is needed.

Celld bundles the Worker entry with esbuild before it publishes it. Declare `"no_bundle": true` in the app's `wrangler.jsonc` when the entry is already a self-contained module (bundled by your own toolchain, no bare imports), or pass `--no-bundle`, which writes that setting into the config the deploy packs.

## 5. Reach Scafo and Celld

Nothing resolves `*.scafo.test`, so these requests supply `Host` explicitly:

```sh
curl -H 'Host: shop.scafo.test' \
  http://127.0.0.1/
curl -H 'Host: shop.scafo.test' \
  http://127.0.0.1/count
curl -H 'Host: shop.scafo.test' \
  http://127.0.0.1/count
curl -H 'Host: shop.scafo.test' \
  http://127.0.0.1/.well-known/celld/health
```

An application is served at one name, `<name>.scafo.test`. The counter increases across requests. The last response is Celld's application health endpoint; it is distinct from `/.well-known/scafo/health` on the node/API listener.

## 6. Inspect the ingress boundary

```sh
curl -s -H "Authorization: Bearer $SCAFO_INGRESS_TOKEN" \
  'http://127.0.0.1:7400/v1/ingress/routes?prefer=self'
curl -H 'Host: operator.test' http://127.0.0.1/
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: nothing.scafo.test' \
  http://127.0.0.1/
```

That document is what Caddy polls every five seconds: one entry per application host, each with the node addresses running it, then the platform API apex as its own entry carrying the prefixes an ingress must never proxy. Caddy keeps no route list of its own, so nothing writes to [`caddy.json`](caddy.json) and the `operator_authored` route in it — matched before the catch-all that consults the document — stays exactly as written. An unclaimed host resolves to no upstream and the error route answers 404; there is no wildcard fallback.

## 7. Use the platform apex safely

```sh
curl -s -H 'Host: scafo.test' \
  http://127.0.0.1/.well-known/scafo/health
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: scafo.test' \
  'http://127.0.0.1/v1/storage/list?prefix='
curl -s -H "Authorization: Bearer $SCAFO_INGRESS_TOKEN" \
  'http://127.0.0.1:7400/v1/storage/list?prefix='
```

The first request reaches the node API through the platform apex. The second is refused by Caddy itself: it resolves no upstream for `/v1/storage` or `/v1/ingress/routes` on a platform host, so neither is ever published there. The same storage route remains available on the node's local listener with the ingress token, which is how Caddy uses it.

## 8. Replace the current deployment

Change `APP_VERSION` in [`app/wrangler.jsonc`](app/wrangler.jsonc) from `v1` to `v2`, then run:

```sh
scafo deploy ./app
curl -H 'Host: shop.scafo.test' http://127.0.0.1/
curl -H 'Host: shop.scafo.test' http://127.0.0.1/count
```

The deploy prints a different build id and the host begins serving `v2`. The durable counter continues because the application's Celld fleet did not change.

Celld exposes one current application deployment per fleet. Previous artifacts may remain in the bucket, but Scafo does not provide an old-build host or historical deployment selector. Track the upstream lifecycle discussion in [Celld issue #181](https://github.com/denoland/celld/issues/181).

## 9. Read observations

```sh
scafo metrics --since 30m
scafo traces --since 30m --name shop
```

Metrics come from the ingress access log and flush every 60 seconds. Traces show non-periodic node events by default; `--all` also includes reconcile passes.

## 10. Tear it down

```sh
docker compose down -v
docker compose ps -a
docker volume ls | grep scafo-single-node
rm -rf .env .scafo
```

The 50-second stop grace is a ceiling, not a fixed wait. With no requests in flight the stack normally stops much sooner.

Next: [the multi-node playground](../multi-node/README.md), or the production-shaped [`../../examples/`](../../examples/).
