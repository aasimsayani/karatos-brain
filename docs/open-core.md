# Open core strategy

Brain A is built in public. The core stays open so jewelers, developers and agencies can adopt it, trust it and contribute to it. Specialized modules that carry the most business value can be offered as private, paid add-ons.

## What stays open (MIT)

- The seven-layer pipeline and its contracts
- Canonical jewelry entities and domain math (karat purity, melt value)
- The Supabase/Postgres schema and migrations
- Reference connectors for common systems (CSV import, Shopify, Stripe)
- Config validation, secret scanning and CI

## Candidates for private modules

These are decided case by case, not committed:

- Bank-statement intelligence (Chase PDF parsing, reconciliation, duplicate detection)
- Advanced reasoners (pricing, metal-market hedging, inventory reorder, customer lifetime value)
- Managed hosting, multi-store dashboards and white-label agents for KaratOS customers
- Premium connectors (HubSpot, Meta/WhatsApp/Instagram, Monday.com)

## Your instance, your data

Every business runs a private instance in accounts it owns: its own Supabase project, its own host and its own credentials. That matters for three reasons:

- **No one else can see the data.** Once setup is finished, we hand over and have no access. Sales, customers, statements and margins never leave the business's own accounts.
- **Nothing is shared by default.** One client's data is never used to price, benchmark or advise another, unless both opt in to a shared feature.
- **The business decides when we come back.** A maintenance plan is optional. Clients who sign up give us access to keep the instance updated and to add integrations based on their needs; clients who don't keep running the public image on their own.

## Rules that keep the split clean

1. Private modules depend on `@karatos/core`. The core never depends on a private module.
2. Extension happens through the public layer contracts (`Normalizer`, `SignalExtractor`, `Reasoner`, `MemoryStore`), so a private module is just another implementation.
3. Nothing customer-specific, such as Fuse Jewelry data, credentials or statements, ever lands in this repo.
4. A public feature is never removed to push people toward a paid one.
