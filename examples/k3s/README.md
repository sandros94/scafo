# Scafo on K3s

This production-shaped example uses K3s's bundled Traefik as the cluster edge. Each Scafo pod retains a node-local Traefik sidecar that polls its colocated node and routes only locally running processes. K3s Traefik forwards the original `Host` header to that sidecar through the `scafo-ingress` ClusterIP Service.

Native direct use of cluster Traefik as Scafo's pull provider is not supported by this example.

## Prerequisites

- K3s's bundled Traefik is enabled and owns the `traefik` IngressClass.
- An external S3-compatible store is reachable from every pod and honours `If-Match` / `If-None-Match` conditional writes.
- The `scafo` namespace and its `scafo-bucket` and `scafo-ingress` Secrets exist before applying the manifest. `scafo-bucket` contains only `SCAFO_S3_ACCESS_KEY` and `SCAFO_S3_SECRET_KEY`; bucket credentials are fleet-root authority. `scafo-ingress` holds `SCAFO_INGRESS_TOKEN`, the one credential the Traefik sidecar presents to its node.
- cert-manager is installed separately. K3s does not bundle it. An operator-created `ClusterIssuer` that can issue the platform apex and wildcard already exists.

Create the namespace and Secrets outside the manifest:

```sh
kubectl create namespace scafo
kubectl -n scafo create secret generic scafo-bucket \
  --from-literal=SCAFO_S3_ACCESS_KEY="$SCAFO_S3_ACCESS_KEY" \
  --from-literal=SCAFO_S3_SECRET_KEY="$SCAFO_S3_SECRET_KEY"
kubectl -n scafo create secret generic scafo-ingress \
  --from-literal=SCAFO_INGRESS_TOKEN="$(openssl rand -base64 32)"
```

`*.apps.example.com` requires DNS-01 validation. Configure the ClusterIssuer, its DNS-provider credentials, and DNS before applying this manifest.

## Apply

1. Edit the non-secret `scafo-node` ConfigMap values: S3 endpoint, bucket, prefix, and transport decision. Replace `apps.example.com` consistently in the ConfigMap, Certificate, and Ingress.
2. Set the manifest image's `VERSION` tag to a published Scafo release. This is the only publication-time substitution; never use a floating tag.
3. Set `Certificate.spec.issuerRef.name` to the existing ClusterIssuer.
4. Apply the manifest and wait for the Certificate and StatefulSet:

   ```sh
   kubectl apply -f scafo.yaml
   kubectl -n scafo wait --for=condition=Ready certificate/scafo-platform --timeout=5m
   kubectl -n scafo rollout status statefulset/scafo-node
   ```

The Certificate covers `apps.example.com` and `*.apps.example.com`. The Ingress routes the platform apex to the Scafo API and application subdomains through K3s Traefik; configure apex and wildcard DNS to the K3s Traefik address.

## Operating constraints

- A fleet is one bucket and prefix. Use separate ones for separate trust domains.
- The external object store is a control-plane dependency, not backup-only storage. Reliable low-latency conditional writes are required.
- `SCAFO_LISTEN=0.0.0.0:7400` permits in-cluster service access. `SCAFO_TRANSPORT=none` is valid only when the pod network is private and trusted; use an explicit transport decision for other networks. With it, runtime processes bind the pod address, which is how the sidecars reach a host's holder on any node.
- The node process stays PID 1 in a private PID namespace. `terminationGracePeriodSeconds: 50` is the minimum; use at least `CELLD_SHUTDOWN_TOTAL_MS + 10s` when that Celld value is raised.
- The StatefulSet gives each node a retained `1Gi` claim through K3s's default StorageClass. This preserves its identity across replacement; size the claim and retention policy for the operator's recovery plan.
- The StatefulSet starts with one replica. Scaling it out is supported: each sidecar reads the fleet's routing from its node and forwards a host to whichever node holds it, its own first.

Use `kubectl -n scafo port-forward svc/scafo-nodes 7400:7400` for deploy and operator commands. Application traffic enters through K3s Traefik, not the node API.
