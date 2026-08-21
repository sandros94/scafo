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
curl -s localhost:7400/v1/health
# {"ok":true,"version":"...","node":"node-368f8285"}
```

`/v1/health` and `/v1/ingress/traefik` are the two routes that answer without a
key — the first is what the probes ask, the second is what the sidecar polls.
Everything else on the agent, `/v1/state` included, wants an operator token and
answers `401` without one.

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
whatever put the request in front of it. **The one thing it must do is leave the
Host header alone** — every routing decision scafo makes is made from it.

### When the cluster already has an ingress controller

A cluster that ships one — k3s does, and it publishes it by taking :80 and :443
on every node — has no port 80 left for a second LoadBalancer. `scafo-ingress`
then never gets an address, the pods meant to carry it sit Pending on `didn't
have free ports for the requested pod ports`, and nothing else looks wrong.

Rather than fight it, put it in front. Make `scafo-ingress`
`type: ClusterIP` and send the existing controller every name under the platform
domain:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: scafo-platform
spec:
  rules:
    - host: "*.apps.example.com"
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: scafo-ingress
                port:
                  number: 80
```

That is two layers of routing and they are not doing the same job: the cluster's
controller picks a pod, any pod, and the sidecar in the pod it picked resolves
the name against the processes that pod actually has ready. Custom domains
claimed through scafo are not under the platform domain, so each needs a rule of
its own here — which is the cost of this shape, and the reason a LoadBalancer
with wildcard DNS in front of it is simpler where the ports are free.

### The sidecar is Traefik v3, and v2 fails quietly

What the node publishes is a v3 dynamic configuration. A v2 Traefik accepts the
document, reports every router as enabled, and serves the ones that match a
single host correctly — but `HostRegexp` means something else in v2, so the
platform domain's catch-all matches nothing and a host waiting to be woken gets
the ingress's own `404` instead of reaching the node. Nothing logs a problem.
Check the tag, especially against a cluster whose bundled controller is older
than the sidecar you are copying this from.

### TLS

Terminate at the cluster's edge and keep the sidecar's `web` entryPoint plain —
with the edge in front, whatever issues its certificate (cert-manager writing a
Secret the controller reads, a cloud load balancer's own) is the cluster's
business and none of scafo's. Terminating in the sidecar instead means adding a
`websecure` entryPoint to its config and setting
`SCAFO_TRAEFIK_ENTRYPOINTS: "web,websecure"` so the published routers attach to
both — and then the certificate has to reach the sidecar: a wildcard for the
platform domain, mounted in as a Secret, since a sidecar per pod issuing per name
would have every pod asking a CA for the same names.

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

## Three rules that must not be violated

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

**More than one pod means `SCAFO_BIND_HOST` past loopback.** Runtime processes
bind loopback by default, which is all a single node needs. As soon as there are
two, one cell still has exactly one owner, and a request landing on a pod that
does not own it is forwarded to the pod that does — at the address that pod
advertises, where a loopback listener answers nothing. The application does not
degrade, it fails: a durable object owned by the other pod answers `The Durable
Object owner is currently unreachable` on roughly half the requests, depending on
which pod the load balancer picked, while stateless paths keep working and hide
it. `SCAFO_BIND_HOST: "0.0.0.0"` in the ConfigMap is what the fleet needs; the
sidecar goes on dialling loopback either way.

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
