# The single-node playground

One bucket, one scafo node, one ingress, thrown away when you are done — the
whole product loop: register a remote, deploy, reach it by name, deploy a second
build, watch the alias move. Type the steps one at a time; each says what you
should see. First: [`../README.md`](../README.md) for what this needs.

## 0. Ports

| Port   | What                                      | Bound to        |
| ------ | ----------------------------------------- | --------------- |
| `80`   | the ingress — where applications answer   | every interface |
| `7400` | the node API — where deploys are accepted | `127.0.0.1`     |
| `8333` | the bucket — where the registry lives     | `127.0.0.1`     |

Port 80 is usually the taken one, and `docker compose up` fails on it naming the
port and not the service. Move any of the three in `.env`.

## 1. Bring the stack up

```sh
cp .env.example .env
docker compose up -d
docker compose logs node
curl -s http://127.0.0.1:7400/v1/health
```

**You should see** `seaweedfs` started, `bucket` **exited**, `node` **healthy**,
`caddy` started, then `listening on http://0.0.0.0:7400 as node "node-eb2d16b1"`,
`coordinator lease taken at fence 1`, and finally
`{"ok":true,"version":"0.0.0","node":"node-eb2d16b1"}`.

An exited `bucket` is success. Compose waits twice on purpose: a node proves the
bucket honours conditional writes before it boots, and Caddy fills its
certificate cache from the node's storage API when it starts. `/v1/health`
answers without a key and reports on the **daemon** — not on whether an
application is serving.

## 2. Point your shell at this playground

```sh
export SCAFO_HOME="$PWD/.scafo"
set -a; . ./.env; set +a
alias scafo='node ../../dist/cli/index.mjs'
```

**You should see** nothing. `SCAFO_HOME` extends the disposability promise to your
operator state: keys and remote registrations land in `.scafo/` here rather than in
your real `~/.scafo`, and `rm -rf .scafo` is the whole undo. Sourcing `.env` gives
the CLI the bucket credentials two steps below need.

> **No node toolchain?** Use `alias scafo='docker compose run --rm cli'` instead,
> and register the remote at `http://node:7400` in step 3 — the CLI is then a
> container on this stack's network. Every other command here is unchanged.

## 3. Register the remote

```sh
scafo remote add playground --endpoint http://127.0.0.1:7400 --register
scafo remote list
```

**You should see** a key minted into `.scafo/keys/playground.json`, then
`registered "op-cf99eff4" as admin-tier; tokens it signs are now accepted by every
node`, then the one remote listed back. A remote entry holds what every other command would
otherwise be told — **where** the installation is and **who** is speaking — and a
single registered remote resolves automatically: nothing below passes `--key` or
`--node`.

## 4. Deploy the application

`app/` is a thirty-line worker: `/` answers with its version and the URL it saw,
`/count` from a durable object.

```sh
scafo deploy ./app --project shop --env production --flip
```

**You should see** `packing`, `accepted`, `uploading`, `routed`, and `build
69981639ba366c2a`. `routed` is the word to wait for. The **build** id is derived
from the content, so that one is yours too until you edit `app/` — and the same
bytes deployed again drop `uploading` entirely.

## 5. Reach it, three ways

Nothing resolves `*.scafo.test`, so send the `Host` header — that header is every
routing decision scafo makes.

```sh
curl -H 'Host: shop.scafo.test'                   http://127.0.0.1/
curl -H 'Host: shop--production.scafo.test'       http://127.0.0.1/
curl -H 'Host: shop--69981639ba366c2a.scafo.test' http://127.0.0.1/
curl -H 'Host: shop.scafo.test' http://127.0.0.1/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1/count
```

**You should see** `{"version":"v1","url":"http://…/"}` three times, each echoing
its own host, then `{"n":1,…}` and `{"n":2,…}`. `<project>--<env>` is the
environment, `<project>` alone is production's short name, and
`<project>--<build>` is _that build specifically_, which stays addressable after
the environment moves on — step 8 leans on it. The counter is here so the same
two calls in the [multi-node playground](../multi-node/README.md), where they
land on _different machines_ and still climb, have something to compare against.

## 6. What the node wrote into Caddy, and what it left alone

```sh
docker compose exec caddy wget -qO- \
  http://127.0.0.1:2019/config/apps/http/servers/scafo/routes | grep -o '"@id":"[^"]*"'
curl -H 'Host: operator.test' http://127.0.0.1/
```

**You should see** seven routes and then `written by hand`:

```
"@id":"operator_authored"
"@id":"scafo_shop--69981639ba366c2a.scafo.test"
"@id":"scafo_shop--production.scafo.test"
"@id":"scafo_shop.scafo.test"
"@id":"scafo_apideny_scafo.test"
"@id":"scafo_api_scafo.test"
"@id":"scafo_catchall_scafo.test"
```

Three names for the build, the apex's denial rule written _before_ the apex's own
route so it wins, and a catch-all that answers for a host whose process is not
running — and wakes it. The node owns only the `scafo_` ones; `operator_authored`
is hand-written in [`caddy.json`](caddy.json) and survives every reconcile.

## 7. The apex, and what it refuses

```sh
curl -s -H 'Host: scafo.test' http://127.0.0.1/v1/health
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: scafo.test' \
  'http://127.0.0.1/v1/storage/list?prefix='
curl -s -H "Authorization: Bearer $SCAFO_STORAGE_TOKEN" \
  'http://127.0.0.1:7400/v1/storage/list?prefix='
```

**You should see** the health document, `404`, then `["last_clean.json"]`.
`*.scafo.test` is one label and never the apex, so the node routes the bare apex
to its own daemon — but `/v1/storage` (private keys) and `/v1/ingress/traefik` (the
routing map) are excluded by **Caddy**, and the daemon behind it is never asked.
That one key is Caddy's certificate bookkeeping, written through the node into
the bucket against the `.env` token: the ingress holds no bucket credential.

## 8. Deploy a second build and watch the flip

Change one line in [`app/wrangler.jsonc`](app/wrangler.jsonc) to
`"vars": { "APP_VERSION": "v2" },`, then deploy and watch the old build's route go
— **in this order**, and the last paragraph is why:

```sh
scafo deploy ./app --project shop --env production --flip
curl -H 'Host: shop.scafo.test' http://127.0.0.1/
docker compose exec caddy wget -qO- \
  http://127.0.0.1:2019/config/apps/http/servers/scafo/routes | grep -c 69981639ba366c2a
```

**You should see** a **different** build id (`3f3c070446280951` if you changed
only that character), then `{"version":"v2",…}`, then `1` — and `0` from that last
command about six seconds later. Ask for the superseded build anyway:

```sh
curl -s -o /dev/null -w '%{http_code} in %{time_total}s\n' \
  -H 'Host: shop--69981639ba366c2a.scafo.test' http://127.0.0.1/
curl -s -H 'Host: shop--69981639ba366c2a.scafo.test' http://127.0.0.1/
curl -H 'Host: shop.scafo.test' http://127.0.0.1/count
```

**You should see** `200 in 0.5s`, `{"version":"v1",…}`, `{"n":3,…}`. **A
superseded build is not gone; it is parked**, and its own name is the door — that
half second is its process starting, which step 9 finds again as latency, and the
count carried across the deploy: new code, same cell, same state.

**And now it is awake, so it stays.** Asking for a parked build stamps it as
wanted, so its route comes back — run that `grep -c` a few seconds later and it is
`1` again. That is why the withdrawal had to be watched first: scafo will not take
away a build you are using.

## 9. What the node counted

```sh
scafo metrics --since 30m
scafo traces --since 30m --project shop
```

**You should see** a row per project and environment, then every rollout ending in
`wake.admitted` and `wake.served` — counters flush every 60 seconds, so wait a
minute if you were quick:

```
PROJECT      ENV                   REQUESTS    BYTES  2XX  3XX  4XX  5XX     P50     P95
(unmatched)  (unmatched)                  3     68 B    2    0    1    0  <=10ms  <=10ms
shop         (build 69981639ba36)         2    132 B    2    0    0    0  <=50ms    <=1s
shop         production                  47  2.27 kB   47    0    0    0  <=10ms  <=10ms
```

The `(unmatched)` row is everything belonging to no project — `operator.test` and
the apex. **The `(build …)` row is the build host**: asking for `shop--<build>` is
not traffic to `production` and is not billed as such, and its `P95` of `<=1s` is
step 8's wake showing up as latency. `--project shop` is doing real work: without
it the last 200 events are almost all the reconcile loop, one pass every 5
seconds. A request that actually wakes something carries an `x-scafo-wake` header,
and `scafo traces --wake <id>` expands that one into its five events.

## 10. Tear it down

```sh
docker compose down -v
docker compose ps -a                        # nothing
docker volume ls | grep scafo-single-node   # nothing
rm -rf .env .scafo
```

**You should see** it take about three seconds — worth knowing because
`stop_grace_period` is **35**, a ceiling and not a wait. With nothing in flight
the drain is over in moments; under real traffic it is not, and Docker's default
of 10 seconds would cut it off mid-drain. The images stay.

Next: [the multi-node playground](../multi-node/README.md) — one cell owned across
two machines, a node killed mid-service. Or the production-shaped
[`../../examples/`](../../examples/).
