# The multi-node playground

Two Scafo nodes, one bucket, one application. This walkthrough shows bucket-led membership, coordinator placement, Celld's cross-node cell ownership, and node drain. Complete the [single-node playground](../single-node/README.md) first.

## 0. Ports

| Port   | What           | Bound to        |
| ------ | -------------- | --------------- |
| `8081` | node A ingress | every interface |
| `8082` | node B ingress | every interface |
| `7401` | node A API     | `127.0.0.1`     |
| `7402` | node B API     | `127.0.0.1`     |
| `8333` | bucket         | `127.0.0.1`     |

The two ingresses are equal addresses until an external load balancer is placed in front of them. Move any port in `.env` when needed.

## 1. Start both nodes

```sh
cp .env.example .env
docker compose up -d
curl -s http://127.0.0.1:7401/.well-known/scafo/health
curl -s http://127.0.0.1:7402/.well-known/scafo/health
```

Both documents report Scafo node/API health. They do not aggregate application health; Celld exposes that per deployed application host.

## 2. Register one remote

```sh
export SCAFO_HOME="$PWD/.scafo"
set -a; . ./.env; set +a
alias scafo='node ../../dist/cli/index.mjs'
scafo remote add playground --endpoint http://127.0.0.1:7401 --register
```

The key is trusted by both nodes because both read the same registry. To run the CLI from the image, use `alias scafo='docker compose run --rm cli'` and register `http://node-a:7400` instead.

## 3. Inspect membership and coordination

```sh
curl -s "$SCAFO_S3_ENDPOINT/scafo?list-type=2&prefix=playground/" | tr '<' '\n' | grep '^Key>'
curl -s "$SCAFO_S3_ENDPOINT/scafo/playground/_scafo/nodes/node-a.json"
curl -s "$SCAFO_S3_ENDPOINT/scafo/playground/_scafo/coordinator/lease.json"
```

The bucket contains separate node and operator keyspaces plus one coordinator lease. Nodes do not join a separate consensus cluster: the shared bucket and key prefix define the installation. Each node advertises the address peers use.

## 4. Deploy to every node

```sh
scafo deploy ./app --project shop --env production --replicas all
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/
curl -H 'Host: shop.scafo.test' \
  http://127.0.0.1:8081/.well-known/celld/health
```

The deploy finishes as `deployed`; each assigned node then reconciles the environment. Both ingresses serve it, and the final request reaches Celld's health endpoint on that application host. Any Scafo node accepts the deployment request; coordinator-only registry work is forwarded to the lease holder.

## 5. One cell owner across two machines

```sh
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/count
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/count
```

The responses form one sequence. Celld owns the durable cell on one runtime node and forwards peer traffic internally. This requires the configured `runtime.bindHost` beyond loopback and a private or WireGuard transport; Celld's peer listener is not a public surface.

## 6. Place an environment on one node

```sh
scafo deploy ./app --project shop --env solo --replicas 1
curl -s "$SCAFO_S3_ENDPOINT/scafo/playground/_scafo/placement/shop/solo.json"
curl -H 'Host: shop--solo.scafo.test' http://127.0.0.1:8081/
curl -H 'Host: shop--solo.scafo.test' http://127.0.0.1:8082/
```

The placement record names one node. Only that node publishes the environment's route; the other ingress returns its native unmatched response. Scafo does not proxy application requests between nodes. Put replicas-constrained workloads behind routing that targets their assigned nodes, or serve them on every node.

Placement uses rendezvous hashing over eligible node ids. A node selector first narrows the candidates; the replica count then chooses from them. The placement fence ties the decision to its coordinator lease.

## 7. Drain a node and restore it

Substitute whichever node holds `solo` or the coordinator lease:

```sh
docker compose stop node-b
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8081/
curl -s "$SCAFO_S3_ENDPOINT/scafo/playground/_scafo/placement/shop/solo.json"
curl -s "$SCAFO_S3_ENDPOINT/scafo/playground/_scafo/coordinator/lease.json"
```

A graceful stop marks the node draining, so placement can move promptly. An uncatchable death cannot do that and must age past the node liveness window before reassignment is safe.

Bring the pair back together:

```sh
docker compose start node-b
curl -s http://127.0.0.1:7402/.well-known/scafo/health
docker compose restart caddy-b
curl -H 'Host: shop.scafo.test' http://127.0.0.1:8082/
```

An ingress using `network_mode: service:node-b` stays attached to the old network namespace when only `node-b` restarts. Restart the pair in operational use: `docker compose restart node-b caddy-b`.

## 8. Inspect the WireGuard refusal

This playground explicitly declares its Docker network trusted with `transport.driver: none`. It does not bring up WireGuard.

```sh
docker compose exec node-a node /app/dist/cli/index.mjs wg init \
  --config /etc/scafo/scafo.config.jsonc --transport wireguard \
  --wg-address 10.83.0.1/24 --wg-endpoint 203.0.113.11:51820 --stdout
```

The image contains neither a WireGuard private key nor `wg`, so this refuses. Scafo never invents tunnel key material, and an interface requires host support plus `NET_ADMIN`.

## 9. Tear it down

```sh
docker compose down -v
docker compose ps -a
docker volume ls | grep scafo-multi-node
rm -rf .env .scafo
```

Next: [`../../examples/kubernetes/`](../../examples/kubernetes/), or the single-host [`../../examples/compose.yaml`](../../examples/compose.yaml).
