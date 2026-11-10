# Roadmap

The README's [Progress](../README.md#progress) section is the live summary: it is generated from [milestones.json](milestones.json) and the integration catalog. When a change finishes a milestone item, mark it done there and run `npm run progress:write`; an item tied to an integration flips on its own when that catalog entry is marked built. This page keeps the detailed history.

This is a rebuild of the original Brain A work (v0.1.0 to v0.1.9, April 2026). The original design docs live in the Fuse Jewelry Google Drive under "BrainA".

## Phase 1: Foundation (this release)
- [x] Seven-layer contracts and pipeline
- [x] Event validation and idempotent ingestion
- [x] Config validation with optional integrations
- [x] Jewelry domain math
- [x] Secret scanning and CI

## Phase 2: Database
- [x] Supabase migrations: events, entities, signals, recommendations, feedback, audit log, sync checkpoints
- [x] Organization and identity tables with row-level security
- [x] Seed data for a sample jewelry store
- [x] `PostgresMemoryStore` implementing `MemoryStore`
- [x] Supabase readiness check and migration runner
- [ ] Apply to the Fuse Jewelry Supabase project (needs owner credentials)

## Phase 2.5: Client instances
- [x] One-instance-per-client API with organization lockdown
- [x] Docker image and real-Postgres smoke test in CI
- [x] Secrets manifest, plan and setup tools
- [ ] Fuse Jewelry instance: Supabase project, host and private repo (needs owner accounts)

## Phase 2.6: Original Brain A plan, completed
- [x] Dead letters, reasoning runs, decisions, outcomes, memories, documentation registry
- [x] Connector contract with checkpoints and retries
- [x] Identity resolution with collision detection
- [x] Documentation drift detection
- [ ] Documentation embeddings for semantic search (pgvector)
- [ ] Reasoning sessions and agent task API

## Phase 2.7: Retail departments
- [x] Department contract with payload schemas, normalizers, extractors and reasoners
- [x] Sales, inventory, clienteling, repairs, custom orders, appraisals, buying and memo, metals and gold buying, marketing, finance, compliance (see [docs/departments](departments/README.md))
- [x] `ENABLED_DEPARTMENTS` per instance
- [ ] Tune thresholds with Fuse Jewelry's real data once connectors are live

## Phase 2.8: Manufacturing departments
- [ ] Bench jobs, casting, stone setting, finishing and quality control
- [ ] Production planning, metal loss and labor cost per piece

## Phase 3: First connectors
- [x] CSV import from any POS (items, stock counts, customers, sales)
- [x] Shopify orders, refunds, fulfillments, products and customers (`@karatos/connectors`)
- [x] Stripe charges, refunds, disputes, payouts and customers
- [x] Bank and card statements from CSV exports
- [x] Bank and card statements from PDFs
- [x] Chase business accounts and cards
- [x] QuickBooks Online

## Phase 3.5: Value, writes and the showcase
- [x] A dollar estimate on each recommendation, from the store's own data
- [x] Value ledger, with results measured at 30, 60 and 90 days ([value-ledger.md](value-ledger.md))
- [x] Careful write-back: every write declared, gated, approved and off by default ([write-back.md](architecture/write-back.md))
- [x] Scheduled connector syncs and raw-data retention in each instance
- [x] Website at karatos.app and the live demo store at karatos.app/demo
- [x] More than 50 connectors, each read-only and tested against a mock built from the vendor's docs ([integrations.md](integrations.md))
- [ ] Demo walkthroughs of the biggest jeweler problems
- [ ] Homepage video of the live dashboard

## Phase 4: First reasoners
- [ ] Claude-powered reasoner with provenance and confidence
- [ ] Feedback loop into future reasoning

## Later
- Self-serve AI dashboards in the Brain Console
- One-command self-hosted install, and a managed hosting plan
- Meta, WhatsApp and Instagram, once the Facebook account is recovered
