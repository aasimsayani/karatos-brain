# KaratOS Brain

Brain A is an open-source operational intelligence layer for jewelry businesses. It turns the data a jewelry shop already has (orders, payments, inventory, customers, bank statements) into auditable events, and then into recommendations a human can trust, check and override.

It is the shared "brain" behind the Fuse Jewelry and KaratOS agents. It is built in public so any jeweler can run the core, and so specialized modules can later be offered as private, paid add-ons.

## What it covers

A jewelry business is many businesses under one roof: a showroom, a repair bench, a custom design studio, a gold buyer, an appraiser, a marketing team and a back office. Most stores run each of these in a different system, or on paper. Brain A treats each one as a **department**, gives it the same seven layers, and lets every department read what the others have learned.

### Departments

Retail jewelry departments are built today. Manufacturing is next.

| Department | What it watches | Example recommendation |
| --- | --- | --- |
| Sales and POS | Every sale and return, in store and online | "RING-14K-001 has been returned 3 of 8 times. Check its sizing and photos before restocking." |
| Inventory and merchandising | What's in the cases, what sells, what sits | "This pendant has sat for 290 days. It's worth $410 at today's gold price if you remake it." |
| Clienteling | Birthdays, anniversaries, wish lists, lifetime value | "Ana's anniversary is in 12 days, and her wish list has the emerald band." |
| Repairs and service | Every ticket from intake to pickup | "Repair R-1042 is 4 days past its promised date. Call the customer today." |
| Custom orders | Design to delivery, deposits and deadlines | "Custom order C-88 is due in 5 days but is still in CAD." |
| Appraisals | Insurance, estate and resale appraisals | "This insurance appraisal is 4 years old. Offer an update." |
| Buying and memo | Vendors, purchase orders, consignment goods | "Memo goods from Vendor X are due back in 6 days. Pay for what sold, and return the rest." |
| Metals and gold buying | Spot prices and buying from the public | "Gold is up 6%. Review prices on 140 gold pieces." |
| Marketing | Campaigns measured by the sales they bring | "The Mother's Day email returned 7x. Repeat it." |
| Finance | Bank activity against what the store took in | "Cash sales exceed cash deposits by $1,200 this month. Reconcile the drawer." |
| Compliance | Cash reporting, anti-money-laundering checks, secondhand-dealer rules | "$11,000 in cash came in for one sale. File IRS Form 8300 within 15 days." |
| *Manufacturing (next)* | *Bench jobs, casting, setting, metal loss, labor cost* | *"Casting loss on 14k yellow is 4% this month, double the usual."* |

Every recommendation carries a confidence score, the expected impact, and links to the exact events and signals behind it, so a person can check it before acting. Compliance items are reminders for the owner, not legal advice.

### Configuring departments per business

Each business turns on only the departments it runs, with one setting:

```bash
# A full-service retail store
ENABLED_DEPARTMENTS=            # empty means every retail department

# A repair-focused shop
ENABLED_DEPARTMENTS=sales,repairs,clienteling,compliance

# An online-only brand
ENABLED_DEPARTMENTS=sales,inventory,marketing,finance
```

A department added later starts with everything already in memory, so it is useful on day one. See the [departments guide](docs/departments/README.md) for every rule, threshold and event.

## What's possible when the systems are connected

The value grows with each connection, because every source adds context to the others. Each customer, product and order becomes one record, no matter which system it came from.

| Connected | What becomes visible |
| --- | --- |
| POS only | What sold and what sits |
| + online store | Total demand across channels, and which pieces only sell in person |
| + repairs | Which customers come back, and which styles keep breaking |
| + bank statements | True margin after card fees, refunds and metal costs |
| + email and messages | Why customers buy, and what they asked for that you didn't have |

Some things only appear once departments share signals. These are built today:

- **Cash at the counter becomes compliance.** Sales records the cash, compliance tracks the Form 8300 deadline and watches for split payments, and finance checks that it reached the bank.
- **A gold price move becomes a pricing review.** Metals sees the spot change, inventory values aged gold pieces at melt, and gold buying flags offers that are too close to melt.
- **An anniversary becomes a sale.** Clienteling knows the date and the customer's wish list, and reaches out only to customers who agreed to marketing.
- **Sell-through drives reorders.** Sales feeds inventory, which recommends reordering what moves and marking down what sits.

These come next, as connectors and reasoners are added:

- **A repair pattern becomes a buying decision.** If a style keeps coming back for the same fix, flag the vendor and stop reordering it.
- **A gold spike becomes a cash plan.** Heavy buying from the public plus a falling price becomes a finance alert.
- **The owner's judgment teaches the system.** Every accept, reject or override is already stored with what happened next. Next, that history will tune which advice the system trusts.

[Why Brain A gets more valuable over time](docs/vision/compounding-value.md) explains each of these mechanisms and the code behind it.

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

## Status

| Area | State |
| --- | --- |
| Seven-layer pipeline, database, one instance per client | Built |
| Retail departments (11) | Built |
| Connectors: CSV, Shopify, Stripe | Next |
| Claude-powered reasoning | Planned |
| Manufacturing departments | Planned |
| Bank statement (PDF) intelligence, CRM, messaging | Later |

See the [roadmap](docs/roadmap.md) and [integrations](docs/integrations.md).

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

Your data stays yours. The database, the container and every credential sit in accounts the business owns, so once setup is done we have no access to any of it. We only come back in if the business signs up for maintenance and asks us to, for example to add integrations it needs. See [docs/open-core.md](docs/open-core.md#your-instance-your-data).

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
