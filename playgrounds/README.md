# Playgrounds

Two disposable scafo installations you can run on your own machine with nothing
but docker, and throw away completely when you are done.

They are for learning and for looking. Each one is a numbered step sheet you type
one line at a time, and each step says what you should see — the fleet coming up,
an application deployed and answered, a build flipped, a node killed and its work
moved. Nothing is scripted, because the point is to watch scafo do it rather than
to watch a script finish.

**They run the real thing.** The real node image, the real ingress, real deploys
served end to end. What is fake is the bucket — a SeaweedFS container standing in
for object storage, which is exactly what the end-to-end suites use, and which
honours the conditional writes scafo's whole registry is built on. No cloud
account, no credentials, no cost, no DNS.

## The disposability promise

Everything a playground creates lives in that playground's docker volumes and in
two files it writes beside itself.

```sh
docker compose down -v      # the whole installation, gone
rm -f .env scafo-operator.json
```

That is all of it. Nothing is installed on your machine, nothing is written
outside the playground's own directory, no system service is registered, no port
is claimed after the containers stop. Run it, break it, delete it, start again —
which is what makes it the right place to try the thing you are not sure about.

## Prerequisites

**Docker with Compose v2.** Nothing else. No node, no pnpm, no `scafo` binary on
your PATH — the CLI is run out of the node's own image.

**Two images, and neither is on a registry you can pull from anonymously yet.**

### 1. The scafo node image — build it

From the root of this repository:

```sh
docker build -t scafo:local .
```

That is the image an operator runs: the agent, the celld runtime it supervises,
and the esbuild that `celld deploy` builds every artifact with. Both playgrounds
name `scafo:local` and neither has a `build:` section, so the image is built once
by you and a slow `up` is never a rebuild happening underneath you.

### 2. The ingress image — pull it

```sh
docker pull ghcr.io/sandros94/scafo-caddy:edge
```

This is [scafo-certmagic](https://github.com/sandros94/scafo-certmagic): stock
Caddy with one extra module, `caddy.storage.scafo`, which keeps certificates,
their private keys and the ACME account **in the bucket** and reaches them
through the node's own `/v1/storage`. It holds no bucket credential — a loopback
URL and a bearer token, and nothing else.

**While the repository is private, that pull needs credentials.** `docker login
ghcr.io` with a GitHub personal access token carrying `read:packages`. If you
cannot, build it from a checkout of the module instead — its Dockerfile does the
`xcaddy` build against a pinned Caddy and copies the binary onto the matching
runtime image:

```sh
git clone https://github.com/sandros94/scafo-certmagic
docker build -t ghcr.io/sandros94/scafo-caddy:edge scafo-certmagic
```

Tag it with the name above and the compose files need no edit. Both also read
`SCAFO_CADDY_IMAGE` from `.env` if you would rather name your own.

> **`:edge`, and not `:latest`.** Both playgrounds hand the storage module its
> token **inline**, as `"token": "{env.SCAFO_STORAGE_TOKEN}"` — one environment
> variable shared by the agent and its ingress, and no file to mount anywhere.
> That spelling is newer than the `v0.1.0` release that `:latest` points at, and
> an older module does not ignore the field, it refuses the whole configuration:
>
> ```
> Error: loading initial config: ... caddy.storage.scafo: json: unknown field "token"
> ```
>
> Caddy exits 1, the node stays healthy, and nothing routes. `:edge` is the head
> of the scafo-certmagic repository and has it. When there is a release carrying
> it, `:latest` will do and this note goes away. The older `token_file` spelling
> works on both, and is what
> [`../scripts/install.sh`](../scripts/install.sh) writes on bare metal — where a
> file's permissions are the whole point and an environment variable would not
> be.

## The two playgrounds

### [`single-node/`](single-node/README.md) — the product loop

A bucket, one node, one ingress. Mint an operator key, deploy a small worker,
reach it by name through the ingress, deploy a second build and watch the alias
move, wake a superseded build by asking for it, and read what the node counted
back out of the bucket.

Start here. It is fifteen steps and about twenty minutes, and it is the whole of
what scafo does on one machine.

### [`multi-node/`](multi-node/README.md) — what only happens at two

Two nodes against the same bucket, each with its own ingress, over plain docker
networking. Watch both heartbeat into the registry, see which one took the
coordinator lease, deploy to both, prove that one durable object has one owner
across two machines, narrow an environment to a single node, then kill that node
and time how long its work takes to move — first gracefully, then not.

There is no WireGuard here. A tunnel exists to make a network between hosts
private, and a docker network on one machine already is; the sheet shows what
`scafo wg` would render for real hosts and deliberately never brings one up.

## Playgrounds are not examples

[`../examples/`](../examples/) is the production-shaped version of the same
things: a single-host compose stack, a Kubernetes Deployment, and the operational
rules that must not be got wrong, written into the files themselves. Those are
meant to be copied and adapted into something you keep.

These are meant to be deleted. So they differ deliberately, and each difference
is commented where it appears:

- **The bucket is in the stack.** A real installation points at object storage it
  already has; here SeaweedFS is a container and a one-shot curl loop makes the
  bucket.
- **The CLI is a container.** A `cli` service behind a compose profile, run with
  `docker compose run --rm cli …`, so nothing has to be installed.
- **The application is here.** `app/` in each playground, a worker of about
  thirty lines whose two routes exist to make routing and durable state visible
  from `curl`.
- **The credentials are fake and in `.env.example`.** They are thrown away with
  the volume.
- **Ports are overridable.** Every published port reads `${VAR:-default}` from
  `.env`, because a development machine is rarely empty and a taken port fails
  the `up` with a message that names the port and not the service.

What they do **not** differ on is anything that would teach you something untrue.
The stop grace is 35 seconds in both. The ingress shares the node's network
namespace in both. `transport` is stated rather than defaulted in both. One
bucket and prefix is one fleet in both.

## What these playgrounds do not cover

**TLS.** Nothing local resolves `*.scafo.test` and no CA would issue for it, so
both playgrounds serve plain HTTP on `:80` — which is what
[`../examples/caddy.json`](../examples/caddy.json) does and what the end-to-end
suites run against. The storage token is real and exercised, and you can watch
Caddy write through `/v1/storage` into the bucket; what is missing is the
certificate traffic that would fill it. The on-demand issuance path — where an
ingress asks the node `/v1/ingress/ask?domain=…` before minting for a name — is a
real endpoint the sheets call by hand, but no ingress configuration in this
repository wires it up yet, so neither playground pretends otherwise.

**Custom domains, varsets, CI deploys, canaries and traffic splits.** All real,
all covered by the end-to-end suites, none of them here — a step sheet that
covers everything is one nobody finishes.
