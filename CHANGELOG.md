# Changelog

## 0.2.0 (unreleased)

Phase 2: the database layer.

- Supabase migrations for organizations, append-only events, identities, entities, signals, recommendations, feedback, sync checkpoints and an audit log
- Row-level security on every table, keyed on the `organization_id` JWT claim
- `@karatos/store-postgres`: `PostgresMemoryStore` and a transactional migration runner
- `npm run supabase:check` explains 401 and 404 failures; `npm run db:migrate [--seed]` applies migrations
- Fictional demo-store seed data
- Migration, RLS and store tests run against embedded Postgres (PGlite), with no external database needed

## 0.1.0 (2026-10-02)

Public rebuild of Brain A from scratch, based on the original v0.1.x design docs.

- Seven-layer contracts (`Normalizer`, `SignalExtractor`, `MemoryStore`, `Reasoner`, `DocumentationSource`) and `BrainPipeline`
- Validated event envelope with idempotent ingestion
- Recommendations always carry provenance and are marked degraded when documentation is stale
- In-memory store for tests and local use
- Jewelry math: karat purity and melt value
- Config validation where only Supabase and the organization id are required
- Secret scanning, CI, MIT license and open-core strategy doc
