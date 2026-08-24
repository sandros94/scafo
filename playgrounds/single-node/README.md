# The single-node playground

One bucket, one scafo node, one ingress, on your machine, thrown away when you
are done. What it teaches is the whole product loop: mint a key, deploy an
application, reach it by name, deploy a second build, watch the alias move.

**This is a step sheet.** Type the steps one at a time and read what comes back —
every one says what you should see. Where scafo is awkward, the awkward thing is
written out rather than hidden behind a script, because the friction is
information.

Before anything here: [`../README.md`](../README.md) for the two images this
needs and how to get them.

---

## 0. Ports, before you start

The stack publishes three ports on your machine:

| Port   | What                                       | Bound to        |
| ------ | ------------------------------------------ | --------------- |
| `80`   | the ingress — where applications answer    | every interface |
| `7400` | the agent API — where deploys are accepted | `127.0.0.1`     |
| `8333` | the bucket — where the registry lives      | `127.0.0.1`     |

A development machine is rarely empty, and **port 80 is the one that is usually
taken**. `docker compose up` fails on a busy port with a message naming the port
and nothing naming the service that wanted it:

```
Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:80
```

Every one of them can be moved in `.env` — `SCAFO_HTTP_PORT`, `SCAFO_AGENT_PORT`
and `SCAFO_STORE_PORT`. Nothing inside the stack changes when you do; only the
`127.0.0.1:<port>` in the commands below. The rest of this sheet assumes the
defaults.

## 1. Write the environment file

```sh
cp .env.example .env
```

Read it. Every setting in it has a comment saying why it is there rather than
in `scafo.config.jsonc` beside everything else.

The one that matters is `SCAFO_STORAGE_TOKEN`. **It is the single value the agent
and its ingress share** — the agent admits it on `/v1/storage`, and Caddy
presents it there to keep its certificates, their private keys and its ACME
account in the bucket without ever holding a bucket credential. The example value
is fine for a playground; a real one is `openssl rand -base64 32`.

Leaving it **empty** is not the same as leaving it out. A node handed an empty
token refuses to boot, because an empty token admits a caller presenting nothing;
compose is written to refuse first, so you get a message naming this file rather
than a node that will not start.

## 2. Bring the stack up

```sh
docker compose up -d
```

**You should see** the four containers come up in a fixed order, with compose
waiting twice:

```
 ✔ Container scafo-single-node-seaweedfs-1  Started
 ✔ Container scafo-single-node-bucket-1     Exited
 ✔ Container scafo-single-node-node-1       Healthy
 ✔ Container scafo-single-node-caddy-1      Started
```

The two waits are the whole start-ordering story. `bucket` is a one-shot curl
loop that creates the bucket and exits; the node does not start until it has,
because a node's first act is to prove the bucket honours conditional writes.
Caddy does not start until the node is **healthy** rather than merely started,
because scafo-caddy fills its certificate cache from storage when it boots, and
storage _is_ the node.

Check where everything stands:

```sh
docker compose ps -a
```

**You should see** `seaweedfs` and `node` and `caddy` up, `node` and `caddy`
marked `(healthy)`, and `bucket` `Exited (0)`. An exited `bucket` is success.

## 3. Watch the node introduce itself

```sh
docker compose logs node
```

**You should see** five or six lines, ending in two that matter:

```
scafo: storage token at /var/lib/scafo/storage-token; mount it read-only into the process that terminates TLS
scafo 0.0.0 listening on http://0.0.0.0:7400 as node "node-eb2d16b1"
scafo: coordinator lease taken at fence 1
```

The node id is generated on first boot and kept in the `state` volume — yours
will differ, and it will be the same one every time this stack restarts until
the volume goes.

That first line is worth knowing is _slightly wrong here_. It always prints, and
it describes the bare-metal handoff: a node that mints its own token writes it
into that file for something else to mount. This stack supplied the token in
`.env` instead, so both sides already have it and there is nothing to mount. The
node still writes the file, so anything that reads it keeps working.

## 4. Ask the agent whether it is up

```sh
curl -s http://127.0.0.1:7400/v1/health
```

**You should see** exactly this shape:

```
{"ok":true,"version":"0.0.0","node":"node-eb2d16b1"}
```

`/v1/health` is one of the two routes that answer without a key. It reports on
the **agent** — it says nothing about whether any application is serving, and it
will go on answering `200` while the runtime processes underneath it restart.

## 5. Prove the two halves share one token

This is the step the playground exists for. The ingress holds no bucket
credential; it holds the token from `.env` and a loopback URL.

Ask the storage surface for its contents with no token at all:

```sh
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:7400/v1/storage/list?prefix='
```

**You should see** `401`. A wrong token and a missing token look identical from
out here, on purpose.

Now with the token from `.env`:

```sh
curl -s -H "Authorization: Bearer $(grep '^SCAFO_STORAGE_TOKEN=' .env | cut -d= -f2-)" \
  'http://127.0.0.1:7400/v1/storage/list?prefix='
```

**You should see** a JSON array with something already in it:

```
["last_clean.json"]
```

Nothing in this playground terminates TLS, so there are no certificates in there
— but that one key is Caddy's certificate-maintenance bookkeeping, written
through the node, into the bucket, against the token you chose. The wiring is
real; only the traffic that would fill it is missing.

> **What this playground does not do.** There is no TLS here: no DNS resolves
> `*.scafo.test`, and no CA would issue for it. The ingress serves plain HTTP on
> `:80`, which is exactly what [`../../examples/caddy.json`](../../examples/caddy.json)
> does and what the end-to-end suites run against. The on-demand certificate path
> — where Caddy asks the node `/v1/ingress/ask?domain=…` before minting for a
> name — is a real endpoint you can call by hand (step 10), but no configuration
> in this repository wires an ingress to it yet, so this sheet does not pretend
> one does.

## 6. Mint an operator key

An operator key signs everything you ask a node to do. It is an Ed25519 pair;
`--register` puts the public half in the registry so every node accepts what it
signs.

```sh
docker compose run --rm cli keygen --config /work/scafo.config.jsonc --register
```

**You should see:**

```
scafo: wrote operator key "op-598cd1ae" to scafo-operator.json
scafo: registered "op-598cd1ae"; tokens it signs are now accepted by every node
```

and `scafo-operator.json` in this directory, mode `0600`, owned by you.

Three awkward things are on that command line, and all three are real:

- **`docker compose run --rm cli`** rather than `scafo`. The playground assumes
  nothing on your machine but docker, so the CLI is the node's own image with its
  entrypoint used as the CLI it is. There is no `scafo` on your PATH unless you
  put one there.
- **`--config /work/scafo.config.jsonc`** rather than nothing. `keygen
--register` writes to the bucket, so it needs the bucket settings, and it looks
  for `./scafo.config.jsonc` in its _working directory_ — which inside that
  container is `/work`, this directory bind-mounted. Leave the flag out and it
  fails on a missing endpoint.
- **`user:` in `compose.yaml`.** The image runs as uid 10001; this directory is
  yours; the key has to land here. If that step failed with a permission error,
  put your own `id -u`:`id -g` into `SCAFO_CLI_USER` in `.env`.

## 7. Deploy the application

`app/` is a worker of about thirty lines. `/` answers with its version and the
URL it saw; `/count` answers from a durable object. Read
[`app/index.js`](app/index.js) — it is short and both routes exist to make
something visible.

```sh
docker compose run --rm cli deploy /work/app \
  --agent http://node:7400 \
  --project shop --env production --flip \
  --key /work/scafo-operator.json
```

**You should see** four lines and a build id, in a few seconds:

```
scafo: packing /work/app
scafo: deploy 66352c67a19352ac accepted
scafo: deploy 66352c67a19352ac uploading
scafo: deploy 66352c67a19352ac routed
scafo: build 69981639ba366c2a
```

`routed` is the word to wait for: accepted, built, the alias flipped onto it, and
a process through its readiness gate with the ingress pointed at it.

The **deploy** id changes every run and names this attempt. The **build** id is
derived from the content, so `69981639ba366c2a` is the id you will see too, as
long as you have not edited `app/` — deploying the same bytes twice produces the
same build, and the second time the `uploading` line is missing entirely because
the artifact was already in the bucket.

Note `--agent http://node:7400` and not `127.0.0.1`. The CLI is a container on
this stack's network, where the node answers to its service name. From your own
shell it would be `http://127.0.0.1:7400`.

## 8. Reach it, three ways

Nothing on your machine resolves `*.scafo.test`. Send the `Host` header — that
header is every routing decision scafo makes.

```sh
curl -H 'Host: shop.scafo.test'            http://127.0.0.1/
curl -H 'Host: shop--production.scafo.test' http://127.0.0.1/
curl -H 'Host: shop--<build>.scafo.test'    http://127.0.0.1/
```

**You should see** the same answer three times, with the host echoed back:

```
{"version":"v1","url":"http://shop.scafo.test/"}
```

Three names, three different meanings. `<project>--<env>` is the environment.
`<project>` alone is the `production` environment's short name. `<project>--<build>`
is _that build specifically_, and it stays addressable after the environment has
moved on — step 12 leans on it.

## 9. See what the node wrote into Caddy, and what it left alone

```sh
docker compose exec caddy wget -qO- http://127.0.0.1:2019/config/apps/http/servers/scafo/routes
```

Caddy's admin API can rewrite everything Caddy serves, so it stays on the
loopback the two containers share and is not published. `exec` reaches it there
and prints the answer on your terminal, so it still pipes into `jq`.

**You should see** an array of seven routes. With `jq` to hand, just their names:

```sh
docker compose exec caddy wget -qO- \
  http://127.0.0.1:2019/config/apps/http/servers/scafo/routes | jq -r '.[]."@id"'
```

```
operator_authored
scafo_shop--69981639ba366c2a.scafo.test
scafo_shop--production.scafo.test
scafo_shop.scafo.test
scafo_apideny_scafo.test
scafo_api_scafo.test
scafo_catchall_scafo.test
```

That is the whole routing model on one screen: three names for the build, the
apex's denial rule written _before_ the apex's own route so it wins, and a
catch-all for everything else under the platform domain — which is what answers
for a host whose process is not running, and what wakes it.

The node owns only the `scafo_`-prefixed ones. `operator_authored` is a route
written by hand in [`caddy.json`](caddy.json) before the node ever ran, and it
survives every reconcile pass:

```sh
curl -H 'Host: operator.test' http://127.0.0.1/
```

**You should see** `written by hand`. That is the contract for an operator's own
hosts, redirects and TLS policies living in the same file.

## 10. The apex is the fleet's front door — and what it refuses

`*.scafo.test` is one label and never `scafo.test` itself, so the node routes
the bare apex to its own agent:

```sh
curl -s -H 'Host: scafo.test' http://127.0.0.1/v1/health
```

**You should see** the same health document as step 4, this time through the
ingress.

Two paths are excluded from it, and the exclusion is **Caddy's** — the agent
behind it is never asked:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: scafo.test' \
  'http://127.0.0.1/v1/storage/list?prefix='
```

**You should see** `404` with an empty body. `/v1/storage` carries private keys
and `/v1/ingress/traefik` is the node's whole routing map; both are for a caller
on this machine, and neither is reachable through a public name.

While you are here, the on-demand certificate question an ingress would ask
before issuing for a name:

```sh
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:7400/v1/ingress/ask?domain=shop.scafo.test'
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:7400/v1/ingress/ask?domain=nobody.example.com'
```

**You should see** `200` then `404`. It takes no key, because an ingress asking
it holds none.

## 11. One cell, one owner

```sh
curl -H 'Host: shop.scafo.test' http://127.0.0.1/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1/count
```

**You should see** `{"n":1,…}`, `{"n":2,…}`, `{"n":3,…}`.

On one node that is unremarkable. It is here so that the same three commands in
the [multi-node playground](../multi-node/README.md) — where the requests land on
_different machines_ and the numbers still climb — have something to be compared
against.

## 12. Deploy a second build and watch the flip

Edit one line in [`app/wrangler.jsonc`](app/wrangler.jsonc):

```c
"vars": { "APP_VERSION": "v2" },
```

Then deploy it exactly as before:

```sh
docker compose run --rm cli deploy /work/app \
  --agent http://node:7400 \
  --project shop --env production --flip \
  --key /work/scafo-operator.json
```

**You should see** the same lines and a **different** build id —
`3f3c070446280951`, if you changed only that one character.

```sh
curl -H 'Host: shop.scafo.test' http://127.0.0.1/
```

**You should see** `{"version":"v2",…}`. The alias moved; the environment's name
now resolves to the new build.

If you are fast enough you may catch it still answering `v1` for a second or so
— `routed` means the node has written the new routing, and the ingress applying
it is a beat behind. Ask again.

Now watch the old build's route be taken away. **Do this before you curl that
build's host** — the order matters, and why is the last paragraph of this step.

```sh
docker compose exec caddy wget -qO- \
  http://127.0.0.1:2019/config/apps/http/servers/scafo/routes | grep -c 69981639ba366c2a
```

**You should see** `1`, and then `0` if you run it again about six seconds later.
The superseded build's process is stopped and its own route removed; the
catch-all is what answers for that name now.

So ask for it anyway:

```sh
curl -s -o /dev/null -w '%{http_code} in %{time_total}s\n' \
  -H 'Host: shop--69981639ba366c2a.scafo.test' http://127.0.0.1/
curl -s -o /dev/null -w '%{http_code} in %{time_total}s\n' \
  -H 'Host: shop--69981639ba366c2a.scafo.test' http://127.0.0.1/
curl -s -H 'Host: shop--69981639ba366c2a.scafo.test' http://127.0.0.1/
```

**You should see** `200 in 0.537s`, then `200 in 0.020s`, then
`{"version":"v1",…}`. The first request woke it — that half second is the process
starting, and step 13 finds it again as latency. **A superseded build is not
gone; it is parked**, and its own name is the door.

**And now it is awake, so it stays.** Asking for a parked build stamps it as
wanted, which keeps its process running and its route in place — run that
`grep -c` again and it is back to `1`, and it will stay `1` for as long as you
keep asking. That is why the withdrawal had to be watched first: a build you are
curling is a build in use, and scafo will not take it away underneath you.

And the durable object:

```sh
curl -H 'Host: shop.scafo.test' http://127.0.0.1/count
```

**You should see** `{"n":4,…}` — the count carried across the deploy. New code,
same cell, same state.

## 13. What the node counted

The node tails Caddy's access log — the only complete account of what this
installation served, because once a process is up its traffic goes ingress →
process and never touches the node again. Counters are flushed to the bucket
**every 60 seconds**, so if you have been quick, wait a minute before this step.

```sh
docker compose run --rm cli metrics --config /work/scafo.config.jsonc --since 30m
```

**You should see** a table per project and environment:

```
scafo: 2026-08-24T16:21:25.707Z .. 2026-08-24T16:51:25.707Z, 9 snapshot(s) from 1 node(s)
PROJECT  ENV               REQUESTS    BYTES  2XX  3XX  4XX  5XX     P50     P95
-        -                        3     68 B    2    0    1    0  <=10ms  <=10ms
shop     3f3c070446280951         2    132 B    2    0    0    0  <=50ms    <=1s
shop     69981639ba366c2a         2    132 B    2    0    0    0  <=50ms    <=1s
shop     production             173  8.33 kB  173    0    0    0  <=10ms  <=10ms
--------------------------------------------------------------------------------
TOTAL                           180  8.66 kB  179    0    1    0  <=10ms  <=10ms
```

Three things in that table are worth stopping on.

The `-  -` row is everything that belonged to no project: `operator.test`, and
the apex. If you curled a host under `scafo.test` that nothing serves, you will
find a row for it under a project of that name instead — the name was parsed, it
just never existed.

**The two rows whose `ENV` is a build id are the build hosts.** Asking for
`shop--<build>.scafo.test` is not traffic to `production` and is not counted as
such, which is right and is also the sort of thing you would rather learn here
than off a bill.

And their `P95` is `<=1s` against `<=10ms` for the environment. That is the wake
from step 12, showing up as latency exactly where it happened.

Now what the nodes _did_, in order:

```sh
docker compose run --rm cli traces --config /work/scafo.config.jsonc --since 30m --project shop
```

**You should see** every rollout, and — at the end — the wake:

```
2026-08-24T16:47:26.061Z  node-36a0e785  rollout.spawned  build=3f3c070446280951 processId=shop--production--3f3c070446280951
2026-08-24T16:47:26.316Z  node-36a0e785  gate.passed      durationMs=255 processId=shop--production--3f3c070446280951 attempts=2
2026-08-24T16:47:29.067Z  node-36a0e785  rollout.holdEnded  processId=shop--production--3f3c070446280951
…
2026-08-24T16:49:45.357Z  node-36a0e785  wake.admitted    id=8b6075307207 host=shop--3f3c070446280951.scafo.test kind=build …
2026-08-24T16:49:45.863Z  node-36a0e785  wake.served      id=8b6075307207 port=42000 status=200
```

Every woken request carries its own id in an `x-scafo-wake` response header, and
that id buys you the whole timeline of one request:

```sh
docker compose run --rm cli traces --config /work/scafo.config.jsonc --wake 8b6075307207
```

**You should see** the half-second from step 12, itemised:

```
scafo: wake "8b6075307207" on node-36a0e785, 5 event(s) over 506ms, starting 2026-08-24T16:49:45.357Z
    +0ms  wake.admitted  id=8b6075307207 host=shop--3f3c070446280951.scafo.test kind=build …
    +0ms  wake.resolved  id=8b6075307207 storeOps=4
    +4ms  wake.stamped   id=8b6075307207
    +4ms  wake.kicked    id=8b6075307207
  +506ms  wake.served    id=8b6075307207 port=42000 status=200
```

**`--project shop` is doing real work in that first command.** Without it, the
last 200 events are almost entirely the reconcile loop — a pass every 5 seconds
whether or not anything happened — and the deploy you came to look at is off the
end of the list, under a footer telling you to raise `--limit`. Both commands
read straight out of the bucket and ask no agent: the nodes that wrote those
numbers may well be gone.

## 14. Tear it down

```sh
docker compose down -v
```

**You should see** the four containers and all five volumes removed. The `-v` is
the whole promise: without it the volumes survive and the next `up` comes back
to this same fleet, this same node identity and this same registry.

It takes about three seconds. That is worth knowing precisely because
`compose.yaml` gives the node a `stop_grace_period` of **35** — the 35 is a
ceiling, not a wait. On SIGTERM the node marks itself draining so the fleet stops
giving it work, releases the coordinator lease, stops reconciling, and only then
stops the processes serving traffic, each of which drains its in-flight requests
for up to 25 seconds. With nothing in flight, as here, all of that is over in
moments. Under real traffic it is not, and Docker's default of 10 seconds would
cut it off mid-drain — which is why the number in the file is 35 and not a
tuning preference.

## 15. Check it really is gone

```sh
docker compose ps -a          # nothing
docker volume ls | grep scafo-single-node   # nothing
```

Two things are left in this directory on purpose, and both are yours:

```sh
rm -f .env scafo-operator.json
```

`scafo-operator.json` is a private key. It is worthless once the bucket holding
its registration is gone, which `down -v` just did — but it is still a private
key, and leaving it lying around is a habit worth not forming.

The images stay. `docker image rm scafo:local ghcr.io/sandros94/scafo-caddy:edge`
if you want the disk back.

---

## Where to go next

- [The multi-node playground](../multi-node/README.md) — the same app on two
  nodes: heartbeats, replicas, one cell owned across machines, and a node killed
  mid-service.
- [`../../examples/`](../../examples/) — the production-shaped versions of this:
  a single-host compose stack and a Kubernetes Deployment, with the operational
  rules that matter written into them.
