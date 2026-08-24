# Playgrounds

Two disposable scafo installations you can run on your own machine and throw away
completely when you are done. Each is a numbered step sheet: one command at a
time, one line saying what you should see. They run the real node image, the real
ingress and real deploys; only the bucket stands in — a SeaweedFS container, which
honours the conditional writes scafo's registry is built on. No cloud account, no
credentials, no DNS.

- [`single-node/`](single-node/README.md) — **start here.** Register a fleet,
  deploy, reach it by name, flip a build, wake a parked one, read what it counted.
- [`multi-node/`](multi-node/README.md) — what only happens at two: the
  coordinator lease, one cell owned across machines, a node killed mid-service.

## The disposability promise

Everything a playground creates lives in its own docker volumes and in two things
beside it:

```sh
docker compose down -v
rm -rf .env .scafo
```

Nothing is installed, no system service registered, no port claimed once the
containers stop, and `.scafo/` is a throwaway `SCAFO_HOME` so your real `~/.scafo`
is never touched.

## Who a fleet trusts

The bucket is the root anchor: whoever holds its credentials holds the fleet. A key
becomes trusted either through the bucket-side ceremony (`--register`, which is how
an installation is bootstrapped and how one whose keys are lost is recovered) or by
an admin adding it through a node. Trusted keys come in two tiers — an `admin`
administers every key the fleet trusts, an `operator` may add keys no higher than
itself and revoke only the key it was registered to replace — so a stolen deploy key
cannot lock the admins out.

## Prerequisites

Docker with Compose v2, and this repository checked out.

```sh
docker build -t scafo:local .          # the node image
pnpm install && pnpm build             # the scafo CLI the sheets alias
docker pull ghcr.io/sandros94/scafo-caddy:edge
```

Neither playground has a `build:` section, so a slow `up` is never a rebuild
happening underneath you. To install no node toolchain at all, each sheet's step 2
gives a container form of the CLI instead.

The ingress is [scafo-certmagic](https://github.com/sandros94/scafo-certmagic):
stock Caddy plus `caddy.storage.scafo`, which keeps certificates and the ACME
account in the bucket through the node's `/v1/storage`, holding no bucket
credential of its own. **`:edge`, not `:latest`** — the playgrounds pass the
storage token inline, and the v0.1.0 module `:latest` points at refuses that field
outright, so Caddy exits 1 and nothing routes. While this repository is private
that pull needs `docker login ghcr.io` with a `read:packages` token; otherwise
`docker build -t ghcr.io/sandros94/scafo-caddy:edge` a checkout of it.

## Not examples, and not everything

[`../examples/`](../examples/) is the production-shaped version — a compose stack,
a Kubernetes Deployment, the rules that must not be got wrong — meant to be copied
and kept. These are meant to be deleted, so the bucket is in the stack, the app is
in `app/`, the credentials are fake, every port is overridable. What they do not
differ on is anything that would teach you something untrue: the stop grace is 35s
in both, the ingress shares the node's namespace in both, one bucket and prefix is
one fleet in both.

Neither does TLS: nothing resolves `*.scafo.test` and no CA would issue for it, so
both serve plain HTTP, as [`../examples/caddy.json`](../examples/caddy.json) and
the end-to-end suites do. Custom domains, varsets, CI deploys, canaries and
traffic splits are all real, all covered by those suites, and none of them here.
