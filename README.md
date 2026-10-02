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
cp .env.example .env.local   # fill in Supabase values
npm run env:check
```

## Packages

| Package | What it is |
| --- | --- |
| `@karatos/core` | Event envelope, layer contracts, pipeline, in-memory store, jewelry math (karat purity, melt value), config validation |

## Open core

The core is MIT-licensed and stays open. Some vertical modules may later ship under a commercial license. See [docs/open-core.md](docs/open-core.md).

## Security

This repository is public. Credentials live only in `.env.local`, which git ignores. CI runs `npm run secrets:scan` on every push. Never commit real customer data or bank statements.

## License

[MIT](LICENSE)
