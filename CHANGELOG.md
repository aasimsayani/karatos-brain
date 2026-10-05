# Changelog

## 0.4.0 (unreleased)

Completes the original Brain A design (v0.1.x docs) on the rebuilt foundation.

- Dead letters: invalid input is stored with its validation issues and raises `DeadLetteredError`. The API returns the dead-letter id.
- Connector contract (`Connector`, `runSync`): historical import, incremental sync, webhooks, checkpointed batches, retries that restart from the checkpoint, and dead-letter counting
- Identity resolution with collision detection (`linkIdentity`, `IdentityCollisionError`)
- Reasoning runs, decisions, outcomes, text-searchable memories and a documentation registry, all with row-level security; decisions and outcomes are audited
- `RegistryDocumentationSource` detects documentation drift and marks reasoning degraded
- Entity kinds are open (lowercase snake_case) so department modules can add their own
- API: `GET /v1/recommendations`, `POST /v1/recommendations/:id/feedback`, `GET /v1/entities/:kind/:id`
- Integration catalog from the original mapping sheet, checked against the secrets manifest
- Docs: compounding-value design, incident runbook and integrations guide

## 0.3.0 (unreleased)

One instance per client, and an agent-readable secrets system.

- `@karatos/server`: an HTTP API (`/healthz`, `/v1/events`, `/v1/reason`) that serves exactly one organization. It needs a per-instance API key and refuses events for any other organization.
- Docker image, published to `ghcr.io/aasimsayani/karatos-brain` from `main`, plus a CI smoke test that runs the image against real Postgres
- `secrets/manifest.json` and its JSON Schema describe every secret and setting, with no values: how to get each one, a pattern to check it, rotation, and whether a machine can generate it
- `npm run secrets:plan [--json]` and `npm run secrets:setup [--generate-only]`
- Reasoning is marked degraded when no documentation registry is configured
- `deploy/instance-template` for a client's private deploy repo; `AGENTS.md` for AI agents
- Coverage gate: 90% lines, functions and statements, and 85% branches

## 0.2.0 (2026-10-02)

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
