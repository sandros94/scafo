# The multi-node playground

Two scafo nodes, one bucket, one application — everything that only becomes true
at two: how nodes find each other (they do not), which one is in charge (whichever
got there first), what happens when a request lands on the node that does not own
the state, and what a node leaving costs.

Do the [single-node playground](../single-node/README.md) first; this one assumes
the loop it teaches, and [`../README.md`](../README.md) for what it needs.

## 0. Ports

| Port   | What             | Bound to        |
| ------ | ---------------- | --------------- |
| `8081` | node A's ingress | every interface |
| `8082` | node B's ingress | every interface |
| `7401` | node A's API     | `127.0.0.1`     |
| `7402` | node B's API     | `127.0.0.1`     |
| `8333` | the bucket       | `127.0.0.1`     |

**Neither ingress takes 80**, and that is what a fleet is before something is put
in front of it: several equal addresses. Move any of the five in `.env`.

## 1. Bring both nodes up

```sh
cp .env.example .env
docker compose up -d
curl -s http://127.0.0.1:7401/v1/health
curl -s http://127.0.0.1:7402/v1/health
```

**You should see** six containers — each ingress waiting for its own node to be
healthy — then two nodes naming themselves `node-a` and `node-b`.

## 2. Point your shell at this playground

```sh
export SCAFO_HOME="$PWD/.scafo"
set -a; . ./.env; set +a
alias scafo='node ../../dist/cli/index.mjs'
scafo remote add playground --endpoint http://127.0.0.1:7401 --register
```

**You should see** a key minted into `.scafo/` here rather than into your real
`~/.scafo`, and `registered "op-…" as admin-tier; tokens it signs are now accepted
by every node`. **One key, and both nodes trust it**, because both read the same
registry — so nothing below passes `--key` or `--node`.

> **No node toolchain?** Use `alias scafo='docker compose run --rm cli'` instead,
> and register at `http://node-a:7400`.

## 3. Watch both nodes heartbeat, in the bucket

```sh
curl -s "$SCAFO_S3_ENDPOINT/scafo?list-type=2&prefix=playground/" | tr '<' '\n' | grep '^Key>'
curl -s "$SCAFO_S3_ENDPOINT/scafo/playground/_scafo/nodes/node-a.json"
curl -s "$SCAFO_S3_ENDPOINT/scafo/playground/_scafo/coordinator/lease.json"
```

**You should see** the whole installation on one screen — a `meta.json`, a record
under `nodes/` for each node and for the operator key you just registered, a
`coordinator/lease.json` — then node A's record carrying
`"addresses":{"internal":"node-a","apiPort":7400}`, then one node named
coordinator with `"ttlMs":15000` and `"fence":1`.

There is no membership API to ask, because there is no cluster.
**`"addresses":{"internal":"node-a"}` is the whole discovery mechanism** — that
string is `SCAFO_ADVERTISE`, and the only way node B learns where node A is. Two
nodes are one fleet because they share a bucket and a prefix, and for no other
reason. **Which one holds the lease is a race**; step 7 takes it away.

## 4. Deploy to both nodes

```sh
scafo deploy ./app --project shop --env production --flip --replicas all
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/
```

**You should see** `routed`, build `69981639ba366c2a` — the same build the other
playground made, since build ids are derived from content — then the same answer
from both ingresses. No `--node`: the fleet's first endpoint is used, and that
choice has no consequence, because **any node accepts any call** and work only the
coordinator may do is forwarded to whichever node holds the lease.

## 5. One cell, one owner, two machines

```sh
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/count
```

**You should see** one sequence and not two — `{"n":1,…}` through `{"n":4,…}`.

**This is the step the whole playground is for.** One fixed name is one cell and
one node owns it; half those requests arrived at a node that does _not_ and were
forwarded — two independent counters would give `1,1,2,2`. What makes it work is
`"runtime": { "bindHost": "0.0.0.0" }`, and **the failure its absence causes is the
worst kind**: `/` keeps working on both, while `/count` fails on half with _"The
Durable Object owner is currently unreachable"_.

## 6. Narrow an environment to one node

```sh
scafo deploy ./app --project shop --env solo --flip --replicas 1
curl -s "$SCAFO_S3_ENDPOINT/scafo/playground/_scafo/placement/shop/solo.json"
curl -s "$SCAFO_S3_ENDPOINT/scafo/playground/_scafo/placement/shop/production.json"
curl -H 'Host: shop--solo.scafo.test' http://127.0.0.1:8081/
curl -H 'Host: shop--solo.scafo.test' http://127.0.0.1:8082/
```

**You should see** `routed` in a few seconds, then one node for `solo` and both
for `production`, then `{"version":"v1",…}` from **both** ingresses — whichever
node placement picked.

Placement is rendezvous hashing over the node ids, so which node holds `solo` is
decided by the fleet and not by the node you asked, and an environment has a
natural home it returns to whenever that node is available. `--flip` waits for the
readiness gate **on the node placement chose**, so the deploy routes just as fast
whichever daemon took it. The `fence` beside the decision is the lease number from
step 3: a decision from a coordinator since replaced can be recognised and
ignored. And placement only decides where a process may **run**, never which door
a request may **arrive** at — the node not running `solo` forwards to the one that
is, which is why a load balancer over a fleet need know nothing about placement.

## 7. Take a node away, and bring it back

Substitute whichever node your `solo` and lease landed on.

```sh
docker compose stop node-b
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/
curl -s "$SCAFO_S3_ENDPOINT/scafo/playground/_scafo/placement/shop/solo.json"
curl -s "$SCAFO_S3_ENDPOINT/scafo/playground/_scafo/coordinator/lease.json"
```

**You should see** it stop in under a second, `production` still answering — it
runs on both nodes — and, within a few seconds, `solo` moved to the survivor and
the lease taken over with `fence` gone up by one.

**That is the fast path, and it is fast because the node said so:** on SIGTERM a
node writes `drainingAt` into its record before stopping anything, so the
coordinator counts it out on its next pass. A _killed_ node says nothing, and the
only safe thing is then to wait out the liveness window — three heartbeat
intervals. `docker compose kill node-b` reaches the same end state after **80-90s**
rather than **3s** — a little under three intervals, because the window runs from
the last heartbeat and not from the death. That gap is the whole argument for
`stop_grace_period`, and for not killing nodes. Now bring it back:

```sh
docker compose start node-b
curl -s http://127.0.0.1:7402/v1/health
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/
docker compose restart caddy-b
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/count
```

**You should see** node B healthy but its ingress answering **nothing at all** —
the connection refused or reset — until `caddy-b` is restarted, and then the count
carrying on from where step 5 left it. **A container that joins another's network
namespace does not follow it through a restart**: stopping `node-b` destroyed that
namespace, and `caddy-b` stayed attached to the one that is gone. **Restart the
pair, not the node** — `docker compose restart node-b caddy-b`, in that order.

## 8. WireGuard, once, and not brought up

Everything above ran with `"transport": { "driver": "none" }` — a statement, not a
default: _this network is already private and trusted_.

```sh
docker compose exec node-a node /app/dist/cli/index.mjs wg init \
  --config /etc/scafo/scafo.config.jsonc --transport wireguard \
  --wg-address 10.83.0.1/24 --wg-endpoint 203.0.113.11:51820 --stdout
```

**You should see it refuse**, for want of a key at `/var/lib/scafo/wg-private.key`
and of a `wg` to make one with — and the refusal is the demonstration. **scafo
never generates your tunnel's key material**, and the image ships no `wg`
deliberately: an interface needs a kernel module and `NET_ADMIN`.

## 9. Tear it down

```sh
docker compose down -v
docker compose ps -a                       # nothing
docker volume ls | grep scafo-multi-node   # nothing
rm -rf .env .scafo
```

`down -v` takes all nine volumes. The two node identities are the ones worth
noticing — a node **is** its keypair, and this destroys them.

Next: [`../../examples/kubernetes/`](../../examples/kubernetes/), this same fleet
as a Deployment, or [`../../examples/compose.yaml`](../../examples/compose.yaml).
