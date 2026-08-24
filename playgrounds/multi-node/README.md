# The multi-node playground

Two scafo nodes, one bucket, one application, on your machine. What it teaches is
everything that only becomes true at two: how nodes find each other (they do
not), which one is in charge (whichever got there first), what happens when a
request lands on the node that does not own the state, and what a node leaving
costs.

**This is a step sheet.** Type the steps one at a time and read what comes back.
Where scafo is awkward, the awkward thing is written out rather than hidden
behind a script.

Do the [single-node playground](../single-node/README.md) first if you have not —
this one assumes the loop it teaches and spends its steps on the differences.

Before anything here: [`../README.md`](../README.md) for the two images this
needs.

---

## 0. Ports, before you start

Five ports, and **neither ingress takes 80**:

| Port   | What               | Bound to        |
| ------ | ------------------ | --------------- |
| `8081` | node A's ingress   | every interface |
| `8082` | node B's ingress   | every interface |
| `7401` | node A's agent API | `127.0.0.1`     |
| `7402` | node B's agent API | `127.0.0.1`     |
| `8333` | the bucket         | `127.0.0.1`     |

Two ingresses cannot both have port 80, and giving it to one would make the pair
look asymmetric when it is not. **That is what a fleet is** before something is
put in front of it: several equal addresses, each serving what its own node runs,
with a wildcard DNS record or a load balancer in front of all of them. See
[`../../examples/kubernetes/README.md`](../../examples/kubernetes/README.md) for
what that costs and what it must not do to the `Host` header.

Any of the five can be moved in `.env` if something on this machine has it.

## 1. Write the environment file

```sh
cp .env.example .env
```

Same three settings as the single-node playground. `SCAFO_STORAGE_TOKEN` is
shared by **all four** services here: each node admits it on its own
`/v1/storage`, and each Caddy presents it to the node it shares a network
namespace with. Nothing crosses between the pairs — node A's Caddy never speaks
to node B — but a fleet has no reason to hold two different tokens.

## 2. Bring both nodes up

```sh
docker compose up -d
```

**You should see** six containers, with the two nodes coming up together and
each ingress waiting for its own node to be healthy:

```
 ✔ Container scafo-multi-node-seaweedfs-1  Started
 ✔ Container scafo-multi-node-bucket-1     Exited
 ✔ Container scafo-multi-node-node-a-1     Healthy
 ✔ Container scafo-multi-node-node-b-1     Healthy
 ✔ Container scafo-multi-node-caddy-a-1    Started
 ✔ Container scafo-multi-node-caddy-b-1    Started
```

```sh
curl -s http://127.0.0.1:7401/v1/health
curl -s http://127.0.0.1:7402/v1/health
```

**You should see** two nodes naming themselves:

```
{"ok":true,"version":"0.0.0","node":"node-a"}
{"ok":true,"version":"0.0.0","node":"node-b"}
```

## 3. Watch both nodes heartbeat — in the bucket, because that is where they are

There is no cluster membership API to ask, because there is no cluster. The
registry is a set of JSON objects in the bucket, and the nodes are two of them.
Read them the way anything else would:

```sh
curl -s 'http://127.0.0.1:8333/scafo?list-type=2&prefix=playground/' \
  | tr '<' '\n' | grep '^Key>'
```

**You should see** the whole installation, on one screen:

```
Key>playground/_scafo/coordinator/lease.json
Key>playground/_scafo/meta.json
Key>playground/_scafo/nodes/node-a.json
Key>playground/_scafo/nodes/node-b.json
Key>playground/_scafo/tls/objects/last_clean.json
```

Now one node's record. The bucket stores it minified, so pipe it through
something that will lay it out — `jq .` if you have it, and `python3 -m
json.tool` if you do not:

```sh
curl -s http://127.0.0.1:8333/scafo/playground/_scafo/nodes/node-a.json \
  | python3 -m json.tool
```

**You should see:**

```
{
  "v": 1,
  "id": "node-a",
  "publicKey": {
    "kty": "OKP",
    "crv": "Ed25519",
    "x": "ZdPy6PMIqePd7H5ZeVcUHDKGvwCCUTGSsmCNOIrZDhg"
  },
  "addresses": { "internal": "node-a", "agentPort": 7400 },
  "heartbeatAt": "2026-08-24T16:56:23.940Z",
  "capacity": {
    "cores": 16,
    "memMb": 56237,
    "cgroup": false,
    "probedAt": "2026-08-24T16:55:53.355Z"
  }
}
```

Run it again in half a minute and `heartbeatAt` will have moved — the heartbeat
interval is 30 seconds, and a node is counted live for three of them.

**`"addresses": { "internal": "node-a" }` is the whole discovery mechanism.**
That string is `SCAFO_ADVERTISE` from `compose.yaml`, written by node A into the
bucket, and it is the only way node B ever learns where node A is. There is no
seed list, no gossip, no join command. Two nodes are one fleet because
`scafo.config.jsonc` gives them the same bucket and the same prefix, and for no
other reason.

And exactly one of them is in charge:

```sh
curl -s http://127.0.0.1:8333/scafo/playground/_scafo/coordinator/lease.json
```

**You should see** one node named, with a 15-second TTL and a fence number:

```
{"v":1,"node":"node-b","acquiredAt":"2026-08-24T16:56:34.350Z","ttlMs":15000,"fence":1}
```

**Which node it is, is a race, and yours may say `node-a`.** Nothing in this
playground makes one of them special. The lease is what serialises the decisions
only one node may make — placement above all — and step 10 takes it away.

## 4. Mint a key and deploy to both nodes

```sh
docker compose run --rm cli keygen --config /work/scafo.config.jsonc --register
```

```sh
docker compose run --rm cli deploy /work/app \
  --agent http://node-a:7400 \
  --project shop --env production --flip --replicas all \
  --key /work/scafo-operator.json
```

**You should see** the same four lines the single-node sheet ends on, and build
`69981639ba366c2a` — build ids are derived from content, so it is the same build
the other playground made.

`--agent http://node-a:7400` names node A, and that is a choice with no
consequence: **any node accepts any call**, and work only the coordinator may do
is forwarded to whichever node holds the lease. You cannot tell from out here,
which is the point.

`--replicas all` says every node serves this environment. It is already the
default for a long-lived environment; it is written out because step 7 changes
it, and the contrast is the lesson.

```sh
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/
```

**You should see** the same answer from both:

```
{"version":"v1","url":"http://shop.scafo.test/"}
```

Two processes, one on each node, each behind its own Caddy. Nothing is shared
between them yet — the next step is where that stops being true.

## 5. One cell, one owner, two machines

Send the same request alternately to the two ingresses:

```sh
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/count
```

**You should see** one sequence, not two:

```
{"n":1,"url":"http://shop.scafo.test/count"}
{"n":2,"url":"http://shop.scafo.test/count"}
{"n":3,"url":"http://shop.scafo.test/count"}
{"n":4,"url":"http://shop.scafo.test/count"}
```

**This is the step the whole playground is for.** The application asks for a
durable object by a fixed name, so there is exactly one cell for it in the fleet,
and exactly one node owns that cell. Half of those requests arrived at a node
that does _not_ own it and were forwarded to the node that does. Two independent
counters would have given you `1, 1, 2, 2`.

**What makes it work is one line in `scafo.config.jsonc`**, and it is worth
reading the comment beside it:

```c
"runtime": { "bindHost": "0.0.0.0" }
```

Runtime processes bind loopback by default, which is everything a single node
needs and useless the moment there are two: the forwarding goes to the address
the owning node advertises, where a loopback listener answers nothing. **The
failure it causes is the worst kind** — `/` keeps working on both nodes because
it holds no state, while `/count` fails on roughly half the requests with _"The
Durable Object owner is currently unreachable"_. The stateless paths hide it
completely.

## 6. Narrow an environment to one node

Deploy a second environment that only one node may serve:

```sh
docker compose run --rm cli deploy /work/app \
  --agent http://node-a:7400 \
  --project shop --env solo --flip --replicas 1 \
  --key /work/scafo-operator.json
```

**You should see, quite possibly, a two-minute wait and then a failure:**

```
scafo: deploy a637a8161f7f747a deployed
scafo: build 69981639ba366c2a
scafo: deploy-not-routed: build "69981639ba366c2a" was deployed and the alias
flipped, but no process serving it had passed its readiness gate after 120000ms
```

**The deploy worked. The command is telling you about itself, not about the
fleet.** `deploy --flip` waits for a process to pass its readiness gate _on the
node it was talking to_, and `--replicas 1` means placement picked exactly one
node — which may not be that one.

The asymmetry is exact, and both halves are worth running:

```sh
# through the node that does NOT hold it
docker compose run --rm cli deploy /work/app --agent http://node-a:7400 \
  --project shop --env solo --flip --replicas 1 --key /work/scafo-operator.json
# through the node that does
docker compose run --rm cli deploy /work/app --agent http://node-b:7400 \
  --project shop --env solo --flip --replicas 1 --key /work/scafo-operator.json
```

**You should see** `deploy-not-routed` after `2m4s` from the first, and `routed`
after `2s` from the second. Same build, same registry, same outcome in the
fleet — one of them just asked a node that was never going to run it.

Which node that is stays put: placement is rendezvous hashing over the node ids,
so an environment has a natural home it returns to whenever that node is
available. Read the placement rather than guessing:

```sh
curl -s http://127.0.0.1:8333/scafo/playground/_scafo/placement/shop/solo.json
curl -s http://127.0.0.1:8333/scafo/playground/_scafo/placement/shop/production.json
```

**You should see** one node for `solo` and both for `production`:

```
{"v":1,"nodes":["node-b"],"decidedAt":"2026-08-24T16:57:19.986Z","fence":1}
{"v":1,"nodes":["node-a","node-b"],"decidedAt":"2026-08-24T16:56:49.389Z","fence":1}
```

That `fence` is the coordinator's lease number from step 3. A placement decision
carries the number of the lease that made it, so a decision from a coordinator
that has since been replaced can be recognised and ignored.

## 7. The node that does not run it still answers for it

`solo` runs on one node. Ask the **other** one:

```sh
curl -H 'Host: shop--solo.scafo.test' http://127.0.0.1:8081/
curl -H 'Host: shop--solo.scafo.test' http://127.0.0.1:8082/
```

**You should see** `{"version":"v1",…}` from both, whichever node placement
picked.

Placement decides where a process may **run**. It never decides which door a
request may **arrive** at: a node with no process for a host forwards to the node
that has one. That is why a load balancer in front of a fleet does not have to
know anything about placement — and it is also why the ingress in front of _this_
pair could be a coin toss and still work.

## 8. Kill a node

Node B, in the transcript below, held both `solo` and the coordinator lease.
Substitute whichever node yours picked.

```sh
docker compose stop node-b
```

**You should see** it stop in under a second. It has nothing in flight to drain;
the `stop_grace_period: 35s` in `compose.yaml` is a ceiling for when it does.

Immediately, before anything has had time to react:

```sh
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/
```

**You should see** `{"version":"v1",…}`. `production` runs on both nodes, so
losing one takes nothing away.

Now watch what only the dead node had:

```sh
curl -s http://127.0.0.1:8333/scafo/playground/_scafo/placement/shop/solo.json
curl -s http://127.0.0.1:8333/scafo/playground/_scafo/coordinator/lease.json
```

**You should see, within a few seconds**, `solo` moved and the lease taken over
with the fence gone up by one:

```
{"v":1,"nodes":["node-a"],"decidedAt":"2026-08-24T16:59:58.000Z","fence":2}
{"v":1,"node":"node-a","acquiredAt":"2026-08-24T16:59:58.115Z","ttlMs":15000,"fence":2}
```

```sh
curl -H 'Host: shop--solo.scafo.test' http://127.0.0.1:8081/
```

**You should see** `{"version":"v1",…}` — the survivor is running it now.

**Three seconds is the fast path, and it is fast because the node said so.** On
SIGTERM a node writes `drainingAt` into its own record before it stops anything,
so the coordinator counts it out on its very next pass.

A node that is _killed_ says nothing, and then the only safe thing to do is wait
out the liveness window — three heartbeat intervals, ninety seconds — before
giving its work away, on the chance that it is merely slow. Do it and time it:

```sh
docker compose kill node-b
```

**You should see** the same end state and a very different wait. Measured on the
transcript above:

|                         | `stop` (SIGTERM, drains) | `kill` (SIGKILL, says nothing) |
| ----------------------- | ------------------------ | ------------------------------ |
| `solo` reassigned after | **3s**                   | **77s**                        |

Seventy-seven rather than ninety because the window runs from the node's last
heartbeat, not from the moment it died. Nothing is lost either way — an
environment served by every node never stops answering at all — but that gap is
the entire argument for `stop_grace_period: 35s` and for not killing nodes.

## 9. Bring it back — and the one thing you must remember

```sh
docker compose start node-b
curl -s http://127.0.0.1:7402/v1/health
```

**You should see** node B healthy again in a few seconds. Now try its ingress:

```sh
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/
```

**You should see nothing at all** — `curl: (7) Failed to connect`, with the node
right there and healthy.

**A container that joins another's network namespace does not follow it through
a restart.** `caddy-b` shares `node-b`'s namespace; stopping `node-b` destroyed
that namespace and starting it made a new one, and `caddy-b` — still up, still
reporting healthy, still happily answering its own admin API — is attached to the
one that is gone. Its published port comes back with the node and leads nowhere.

Restart the ingress and it is fixed:

```sh
docker compose restart caddy-b
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/
```

**You should see** `{"version":"v1",…}` again.

**Restart the pair, not the node.** `docker compose restart node-b caddy-b`, in
that order, or `docker compose up -d --force-recreate node-b caddy-b`. The same
rule applies to `examples/compose.yaml` and to any Kubernetes pod where the
ingress is a sidecar — except there the kubelet restarts the whole pod, which is
exactly why the shape is safer on Kubernetes than under compose.

And the state came through all of it:

```sh
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/count
```

**You should see** the count carry on from where step 5 left it — `{"n":5,…}`,
`{"n":6,…}` — across a node that stopped, a cell that changed owner, and a node
that came back.

## 10. WireGuard, once, and not brought up

Everything above ran with `"transport": { "driver": "none" }`, which is a
statement rather than a default: _this network is already private and trusted_.
On one docker network on one machine, it is.

Between real hosts it usually is not, and then the transport is `wireguard` and
`scafo wg` renders the interface. Ask for it — on a node, because a tunnel
configuration is a node's own, and `--stdout` so it is printed rather than
written:

```sh
docker compose exec node-a node /app/dist/cli/index.mjs wg init \
  --config /etc/scafo/scafo.config.jsonc \
  --transport wireguard --wg-address 10.83.0.1/24 --wg-endpoint 203.0.113.11:51820 \
  --stdout
```

**You should see it refuse, and the refusal is the demonstration:**

```
scafo: No WireGuard private key: this node has no key at
"/var/lib/scafo/wg-private.key" and no "wg" on PATH to make one with: run
"wg genkey > /var/lib/scafo/wg-private.key" and "chmod 600
/var/lib/scafo/wg-private.key", or install wireguard-tools and run "scafo wg
init" again — scafo never derives an X25519 key itself, so the key material is
only ever the operator's own
```

Two things are in that message. **scafo never generates your tunnel's key
material** — it reads a key you made and writes the configuration around it.
And the node image ships no `wg`, deliberately: a WireGuard interface needs a
kernel module and `NET_ADMIN`, which is a thing to give a host and not a
playground container. `scafo wg peers --stdout` re-renders the same file from
whichever nodes are registered at the time, and stops in the same place for the
same reason.

**Real tunnels belong to real multi-host fleets**, where the hosts have
wireguard-tools, the keys are the operator's, and the network between them is
one you would not otherwise trust.

Two smaller things worth knowing if you go looking:

- Run that through `docker compose run --rm cli` instead of `exec` and it fails
  with a raw Node stack trace ending in `EACCES … /var/lib/scafo/node.json`. A
  tunnel command needs the node's identity, and the one-shot CLI container has
  no state volume — but the error says so only by accident.
- `docker compose exec` does not use the image's entrypoint, which is why that
  command spells out `node /app/dist/cli/index.mjs` where every other step just
  says `cli`.

## 11. Tear it down

```sh
docker compose down -v
docker compose ps -a                       # nothing
docker volume ls | grep scafo-multi-node   # nothing
rm -f .env scafo-operator.json
```

`down -v` takes all nine volumes: the bucket, both node identities, both ingress
logs and both Caddys' own directories. The two node identities are the ones worth
noticing — a node **is** its keypair, and this is the deliberate act that
destroys them.

---

## Where to go next

- [`../../examples/kubernetes/`](../../examples/kubernetes/) — this same fleet as
  a Deployment, where the ingress is a sidecar, node identity is disposable on
  purpose, and the README lists the three rules that must not be violated.
- [`../../examples/compose.yaml`](../../examples/compose.yaml) — the
  production-shaped single host, and the note on what turns it into a fleet.
