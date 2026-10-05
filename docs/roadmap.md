# Roadmap

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

## Phase 3: First connectors
- [ ] CSV import (orders, products, bank transactions)
- [ ] Shopify orders and products
- [ ] Stripe payments

## Phase 4: First reasoners
- [ ] Claude-powered reasoner with provenance and confidence
- [ ] Feedback loop into future reasoning

## Later
- Bank-statement PDF intelligence (5 to 6 years of Chase statements)
- HubSpot, Slack, Monday.com
- Meta, WhatsApp and Instagram, once the Facebook account is recovered
