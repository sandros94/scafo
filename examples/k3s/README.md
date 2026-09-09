# Scafo on K3s

This production-shaped example makes K3s's bundled Traefik the fleet's ingress. Traefik polls `/v1/ingress/routes/traefik` on the Scafo pods through the `scafo-api` Service and routes each host to whichever pod runs it, so the pods carry no ingress of their own.

Scafo's routers are `<name>@http`; operator-owned Ingress and IngressRoute objects keep working beside them in their own providers.

## Prerequisites

- K3s v1.32 or newer with its bundled Traefik enabled. Older releases ship Traefik 2.11, which has no `providers.http.headers` and cannot present the ingress token. RKE2 works the same way; see the notes in [traefik-config.yaml](traefik-config.yaml) for its chart name and manifests directory.
- An external S3-compatible store, reachable from every pod, honouring `If-Match` / `If-None-Match` conditional writes.
- cert-manager, installed separately — K3s does not bundle it — with a `ClusterIssuer` that can issue the platform apex and its wildcard. That needs DNS-01, so configure the issuer, its DNS-provider credentials, and DNS first.
- Apex and wildcard DNS pointing at the K3s Traefik address.

Create the namespace and Secrets outside the manifest. `scafo-bucket` holds the bucket credentials, which are fleet-root authority. `scafo-ingress` holds `SCAFO_INGRESS_TOKEN`, the one credential an ingress ever holds; Traefik runs in `kube-system`, so the same token goes there too.

```sh
kubectl create namespace scafo
kubectl -n scafo create secret generic scafo-bucket \
  --from-literal=SCAFO_S3_ACCESS_KEY="$SCAFO_S3_ACCESS_KEY" \
  --from-literal=SCAFO_S3_SECRET_KEY="$SCAFO_S3_SECRET_KEY"

INGRESS_TOKEN="$(openssl rand -base64 32)"
kubectl -n scafo create secret generic scafo-ingress \
  --from-literal=SCAFO_INGRESS_TOKEN="$INGRESS_TOKEN"
kubectl -n kube-system create secret generic scafo-ingress \
  --from-literal=SCAFO_INGRESS_TOKEN="$INGRESS_TOKEN"
```

## Apply

1. Edit the non-secret `scafo-node` ConfigMap values: S3 endpoint, bucket, prefix, and transport decision. Replace `apps.example.com` consistently in the ConfigMap, Certificate, and Ingress.
2. Set the manifest image's `VERSION` tag to a published Scafo release. This is the only publication-time substitution; never use a floating tag.
3. Set `Certificate.spec.issuerRef.name` to the existing ClusterIssuer.
4. Apply the manifest and wait for the Certificate and the StatefulSet:

   ```sh
   kubectl apply -f scafo.yaml
   kubectl -n scafo wait --for=condition=Ready certificate/scafo-platform --timeout=5m
   kubectl -n scafo rollout status statefulset/scafo-node
   ```

5. Set the ACME contact address in `traefik-config.yaml`, then place it on every server node. The helm-controller picks it up and upgrades the bundled release.

   ```sh
   sudo cp traefik-config.yaml /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
   kubectl -n kube-system rollout status deploy/traefik
   ```

## Verify

```sh
kubectl -n kube-system logs deploy/traefik | grep -i "provider.*http"
curl -sk https://<cluster-edge>/.well-known/scafo/health -H "Host: apps.example.com"
```

A deployed environment answers at its own host the same way. Until a project is deployed, only the platform apex is routed: Scafo publishes no wildcard fallback, and an unclaimed host is a 404 at the edge.

## Certificates

- The platform apex and `*.apps.example.com` come from cert-manager. The rules-less `scafo-platform-tls` Ingress exists only to put that Secret into Traefik's certificate store, which is matched by SNI for the `@http` routers.
- A custom domain an environment claimed is issued by Traefik itself, HTTP-01 on the `web` entryPoint, once its DNS points at the cluster edge. Traefik skips any host the store already covers, so the wildcard is never re-issued.

## Operating constraints

- A fleet is one bucket and prefix. Use separate ones for separate trust domains.
- The external object store is a control-plane dependency, not backup-only storage. Reliable low-latency conditional writes are required.
- `SCAFO_LISTEN=0.0.0.0:7400` permits in-cluster service access. `SCAFO_TRANSPORT=none` is valid only when the pod network is private and trusted; use an explicit transport decision for other networks. With it, runtime processes bind the pod address, which is how Traefik reaches a host's holder on any node.
- The node process stays PID 1 in a private PID namespace. `terminationGracePeriodSeconds: 50` is the minimum; use at least `CELLD_SHUTDOWN_TOTAL_MS + 10s` when that Celld value is raised.
- The StatefulSet gives each node a retained `1Gi` claim through K3s's default StorageClass. This preserves its identity across replacement; size the claim and retention policy for the operator's recovery plan.
- The StatefulSet starts with one replica and scales out: the routing Traefik polls names every pod serving a host, so a new node joins the edge as soon as it runs something.

Application traffic enters through K3s Traefik, not the node API.

## First deploy

No pod holds an operator key, and `kubectl exec` is not where one is minted: the first key is minted on your own machine.

1. Install the CLI:

   ```sh
   npm install --global scafo
   ```

2. Give that shell the pods' bucket values — endpoint, bucket, region and prefix from the `scafo-node` ConfigMap, credentials from the `scafo-bucket` Secret. `SCAFO_S3_PREFIX` must be the ConfigMap's, `production` in this manifest: a different prefix is a different, empty installation.

   ```sh
   kubectl -n scafo get configmap scafo-node -o yaml
   kubectl -n scafo get secret scafo-bucket -o jsonpath='{.data.SCAFO_S3_ACCESS_KEY}' | base64 -d; echo
   kubectl -n scafo get secret scafo-bucket -o jsonpath='{.data.SCAFO_S3_SECRET_KEY}' | base64 -d; echo

   export SCAFO_S3_ENDPOINT="https://s3.example.com"
   export SCAFO_S3_BUCKET="scafo"
   export SCAFO_S3_ACCESS_KEY="<access key>"
   export SCAFO_S3_SECRET_KEY="<secret key>"
   export SCAFO_S3_REGION="us-east-1"
   export SCAFO_S3_PREFIX="production"
   ```

3. Mint and register the first admin key:

   ```sh
   scafo remote add prod --endpoint https://apps.example.com --register
   ```

4. Confirm the pods are there, with their CELLD and SCAFO versions:

   ```sh
   scafo fleet nodes
   ```

5. Deploy:

   ```sh
   scafo deploy ./my-app --project shop --env production
   ```

Without the apex, forward the node API instead: `kubectl -n scafo port-forward svc/scafo-nodes 7400:7400` and add `--node http://127.0.0.1:7400` to each command.

See [Deploying](https://scafo.dev/deploy/k3s#deploying) for what each step does, and for the `scafo trust set` policy a CI job deploys through.
