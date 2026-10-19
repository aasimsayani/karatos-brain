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

Every business runs a private instance: its own database, its own host and its own credentials, never shared with another client. On Core it sits in accounts the business owns; on Managed we run it for them. That matters for three reasons:

- **No one else can see the data.** On Core, once setup is finished, we hand over and have no access. On Managed, we reach it only to keep it running. Sales, customers, statements and margins never leave that business's instance.
- **Nothing is shared by default.** One client's data is never used to price, benchmark or advise another, unless both opt in to a shared feature.
- **The business decides who runs it.** On Core, the instance lives in the business's own accounts and we have no access once setup is done. On Managed, we host it, still isolated from every other client, and reach it only to keep it updated and add integrations. Clients can move between the two, and anyone can keep running the public image on their own.

## The Brain Console is paid

The Brain Console, the owner's daily dashboard, is a private module. Its code lives in a private repository and runs only for clients on a paid plan, priced per store: Core at $299 a month runs in accounts the business owns, and Managed at $599 a month is hosted and maintained by us. Each plan includes console seats and the standard connectors; setup is a one-time fee, and multi-store, wholesale and custom integrations are quoted.

The open core keeps everything the console reads from: the recommendations and feedback API, provenance and the degraded flag. Anyone can build their own interface on that API; the Brain Console is ours.

## Rules that keep the split clean

1. Private modules depend on `@karatos/core`. The core never depends on a private module.
2. Extension happens through the public layer contracts (`Normalizer`, `SignalExtractor`, `Reasoner`, `MemoryStore`), so a private module is just another implementation.
3. Nothing customer-specific, such as Fuse Jewelry data, credentials or statements, ever lands in this repo.
4. A public feature is never removed to push people toward a paid one.
