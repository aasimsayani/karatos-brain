# KaratOS Brain

Brain A is an open-source operational intelligence layer for jewelry businesses. It turns the data a jewelry shop already has (orders, payments, inventory, customers, bank statements) into auditable events, and then into recommendations a human can trust, check and override.

It is the shared "brain" behind the Fuse Jewelry and KaratOS agents. It is built in public so any jeweler can run the core, and so specialized modules can later be offered as private, paid add-ons.

## How it works

Every piece of data passes through seven layers, in order. No layer can be skipped.

1. **Event Ingestion:** raw source data becomes an immutable, validated event with an idempotency key.
2. **Entity Normalization:** events map onto canonical entities: customer, product, order, payment and supplier.
3. **Signal Extraction:** typed observations derived from entities, traceable back to their events.
4. **Memory + State:** durable storage for events, entities, signals and decisions.
5. **Reasoning:** recommendations with confidence, expected impact and provenance.
6. **Feedback + Learning:** human accept, reject or override decisions are recorded as first-class signals.
7. **Documentation:** reasoning checks the current docs and marks itself *degraded* when they are stale.

See [docs/architecture/overview.md](docs/architecture/overview.md) for details.

## Quick start

```bash
npm install
npm test
cp .env.example .env.local
npm run secrets:setup        # generates keys, then asks for the rest one at a time
npm run supabase:check
npm run db:migrate
```

## One instance per client

Each business runs its own instance: its own Supabase project, container, API key and private deploy repo, all on the same public image. See [docs/deployment/instances.md](docs/deployment/instances.md).

## Packages

| Package | What it is |
| --- | --- |
| `@karatos/core` | Event envelope, layer contracts, pipeline, in-memory store, jewelry math (karat purity, melt value), config validation |
| `@karatos/retail` | Retail jewelry departments: sales, inventory, clienteling, repairs, custom orders, appraisals, buying, metals, marketing, finance, compliance. See [departments](docs/departments/README.md) |
| `@karatos/store-postgres` | Postgres/Supabase `MemoryStore`, migration runner |
| `@karatos/server` | HTTP API for one client instance, shipped as the `ghcr.io/aasimsayani/karatos-brain` image |

The database schema lives in [`supabase/migrations`](supabase/migrations). See the [Supabase setup runbook](docs/runbooks/supabase-setup.md).

## Open core

The core is MIT-licensed and stays open. Some vertical modules may later ship under a commercial license. See [docs/open-core.md](docs/open-core.md).

## Security

This repository is public. Every secret an instance needs is described, without values, in [`secrets/manifest.json`](secrets/manifest.json). See [docs/secrets.md](docs/secrets.md). Values live only in `.env.local` or a host's secret store. CI runs `npm run secrets:scan` on every push. Never commit real customer data or bank statements.

AI agents working in this repo should read [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
