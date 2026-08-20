# scafo on Kubernetes

`node.yaml` runs a two-node scafo fleet: a Deployment whose every pod carries the
node agent and the Traefik that fronts it, a headless Service that makes the
individual nodes addressable, and a LoadBalancer that puts one address in front
of all of them.

## Applying it

1. Have a bucket. Any S3-compatible store that honours conditional writes
   (`If-Match` / `If-None-Match`) will do — scafo has no database and no
   consensus protocol, and that bucket is the whole of its state.
2. Build the node image and push it where the cluster can pull it:
   `docker build -t <your-registry>/scafo:<tag> .` from the repository root.
   Put that reference in the Deployment's `node` container.
3. Edit the `scafo-bucket` Secret (credentials) and the `scafo-node` ConfigMap
   (endpoint, bucket, prefix, platform domain) at the top of `node.yaml`.
4. `kubectl apply -f node.yaml`

Everything is in that one file and the order within it is already correct: the
Secret and the ConfigMaps come before the Deployment that mounts them. The first
node to arrive bootstraps the registry, which also proves the bucket honours
conditional writes before anything is written for real — a store that does not
fails the boot loudly rather than corrupting state later.

Watch it come up:

```sh
kubectl rollout status deploy/scafo-node
kubectl port-forward svc/scafo-nodes 7400:7400
curl -s localhost:7400/v1/state | jq
```

## How traffic gets in

The `scafo-ingress` LoadBalancer publishes port 80 in front of every pod's
Traefik sidecar. Point a wildcard DNS record at whatever address it gets:

```
*.apps.example.com  ->  <EXTERNAL-IP of scafo-ingress>
```

An application is then reachable at `<project>--<env>.apps.example.com`, at
`<project>.apps.example.com` for its `production` environment, and at
`<project>--<build>.apps.example.com` for every build that is running.

Nothing about that path is scafo-specific on the cluster's side, and it does not
have to be a LoadBalancer: an Ingress or a Gateway pointed at the same pods works
the same way, because what routes a request is the Traefik inside the pod, not
whatever put the request in front of it. For TLS, terminate at the cluster's edge
and keep the sidecar's `web` entryPoint plain, or add a `websecure` entryPoint to
the sidecar's config and set `SCAFO_TRAEFIK_ENTRYPOINTS: "web,websecure"` so the
published routers attach to both.

**One address in front of every node has a consequence for `--replicas`.** A node
routes to the processes IT runs and to nothing else — routing follows readiness,
not intent. An environment served by every node (the default for long-lived
environments) answers from whichever pod the load balancer picks. An environment
narrowed to fewer, with `scafo deploy --replicas 1` or a `--node-selector`,
answers `404` from the pods that do not serve it. Narrow an environment's
replicas only when what reaches it knows which nodes hold it.

## Deploying to it

`scafo deploy` talks to one node's agent API, which is not published outside the
cluster by design — it accepts deploys and commands that node. Reach it with
`kubectl port-forward svc/scafo-nodes 7400:7400`, or run CI's deploy step inside
the cluster against `scafo-nodes:7400`. Any node accepts the call; work that only
the coordinator may do is forwarded to whichever node holds the lease.

## Two rules that must not be violated

**The stop grace stays at 35 seconds or more.** On SIGTERM a node writes that it
is draining, releases the coordinator lease, stops reconciling, closes its
listener, and only then stops the celld processes serving traffic — each drains
its in-flight requests for 25s and is given 30s before it is killed. Kubernetes'
default of 30 cuts that off in the middle: requests are dropped mid-flight, and
the fleet has to time the node out over the liveness window instead of being told
it left. `terminationGracePeriodSeconds: 35` is the minimum, not a suggestion.

**One bucket and prefix is one fleet.** Every node naming the same
`SCAFO_S3_BUCKET` and `SCAFO_S3_PREFIX` is part of the same installation: they
share every record, compete for one coordinator lease, and are placed against
each other. Two installations that share them will fight; two that differ in
either share nothing at all. Never point a staging fleet at production's prefix
to "have a look" — a node that boots there registers itself and is given work.

## What is disposable, and what is not

Node identity is disposable here on purpose. The state volume is an `emptyDir`,
so a replaced pod comes up, generates a fresh identity, registers it and is given
work; the record its predecessor left is counted out after the liveness window
and never given work again. The registry in the bucket is the truth and survives
every pod.

A PersistentVolumeClaim buys stable node ids across restarts — steadier
rendezvous placement, so fewer environments move when a pod is replaced, and a
registry that does not accumulate inert records — at the cost of a StatefulSet
and per-pod storage. It is an optimisation, not a requirement.

The bucket is the opposite: it is the only thing here that must be backed up.
