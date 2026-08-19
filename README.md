# scalo

Self-hosted serverless deployment platform for JS apps.

> ⚠️ Work in progress — not yet published.

Its state is a registry of JSON objects in an S3-compatible bucket, mutated only
through conditional writes. There is no database and no consensus protocol, and
a single binary is both the node agent and the CLI.

## Quickstart

A whole installation on one host — a bucket, one node, and the Caddy it routes
through — from a checkout:

```sh
pnpm install && pnpm build
docker compose -f examples/compose.yaml up --build -d
```

Then mint an operator key and deploy something. The key lands in
`./scalo-operator.json`, which is where `deploy` looks for it:

```sh
export SCALO_S3_ENDPOINT=http://127.0.0.1:8333 SCALO_S3_BUCKET=scalo \
       SCALO_S3_ACCESS_KEY=scalo SCALO_S3_SECRET_KEY=scalo-secret

node dist/cli/index.mjs keygen --register
node dist/cli/index.mjs deploy ./my-app --agent http://127.0.0.1:7400 \
  --project shop --env production --flip

curl -H 'Host: shop.scalo.test' http://127.0.0.1
```

The application is reachable at `<project>--<env>.scalo.test`, at
`shop.scalo.test` for the `production` environment, and at
`<project>--<build>.scalo.test` for every build that is running. Nothing resolves
those names for you — send the `Host` header, or add them to `/etc/hosts`.

## Running it for real

- **The node image:** `docker build -t scalo .` — the agent, celld and esbuild in
  one image. `ENTRYPOINT` is the CLI, so `docker run scalo up --listen 0.0.0.0:7400`
  is the whole invocation. **Give it a stop grace of at least 35 seconds**
  (`stop_grace_period: 35s`, `terminationGracePeriodSeconds: 35`): a node drains
  its in-flight requests on the way out, and a shorter grace kills it mid-drain.
- **One host:** [`examples/compose.yaml`](./examples/compose.yaml), the stack the
  quickstart runs. Every operational rule it depends on is a comment in it.
- **Kubernetes:** [`examples/kubernetes/`](./examples/kubernetes/) — the same node
  as a Deployment with a Traefik sidecar, and a README covering what must not be
  got wrong.
- **A fleet:** run the same node on every host against the SAME bucket and prefix.
  That, and nothing else, is what makes them one installation.

## License

[Apache-2.0](./LICENSE)
