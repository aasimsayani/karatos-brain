# KaratOS Brain

**The operating brain for jewelry businesses.** KaratOS reads the systems a jeweler already uses, connects what each one knows, and tells the owner what to do today, with the evidence behind every suggestion.

## Why it matters

A jewelry store is a showroom, a repair bench, a custom studio, a gold buyer, an appraiser and a back office under one roof. Each runs on a different system, or on paper, so the owner decides by feel and money leaks in the gaps between them:

- **Inventory sits.** Pieces stay in the case for a year while gold moves, and nobody reprices or remakes them.
- **Promises slip.** Repairs and custom orders run past the date the customer was given.
- **Cash drifts.** Sales, deposits and card fees never get matched, so true margin is a guess.
- **Deadlines hide.** A $10,000 cash sale needs an IRS Form 8300 within 15 days, and nobody is tracking it.
- **Customers go quiet.** Anniversaries and wish lists live in a notebook instead of a reminder.

KaratOS closes those gaps. Every sale, repair, payment and bank line becomes one auditable record, and eleven departments read those records to suggest the next action: reprice these pieces, call this customer, reconcile this drawer, file this form. The owner accepts, rejects or adjusts each one, and that choice is kept so the advice gets better.

## What a jeweler gets

- **One picture of the business.** A customer, product or order is one record, whichever system it came from.
- **A short list of what to do today**, each item with its confidence, its expected impact, and links to the exact records behind it.
- **Value that grows with each connection.** POS alone shows what sells. Add the online store, the bank and the books, and it shows true margin, cross-channel demand and cash that never reached the bank.
- **Your data stays yours.** Each business runs its own isolated instance. Self-host it for free, or let us host it on the managed plan.
- **Read-only by default.** KaratOS reads from your systems and never changes them unless you turn a specific action on.

## Who it's for

- **Independent jewelers with one to five stores**, where the owner is also the buyer, the bookkeeper and the compliance officer. They feel every gap above and have no analyst to close it.
- **Online and hybrid jewelry brands** whose demand is split across a web store, marketplaces and appointments, and who need to know which channel actually pays.
- **Groups and studios with a bench**, where repairs and custom work are a large share of revenue and a missed promise date costs a customer for life.

The common thread is a business that already runs good systems and still decides by feel, because no single system sees the whole store.

## The value of each connection

KaratOS is useful with one connection and gets sharper with each one, because every system answers a question the others can't. These are the questions each kind of connection answers for the owner:

| When you connect | The question it answers | Why the owner cares |
| --- | --- | --- |
| **Online store and POS** | What sold, where, and what has sat too long? | Aged inventory is cash locked in the case. Seeing it by piece, not by category, is what makes a remake or markdown decision possible. |
| **Payments and processors** | What did each sale really net after fees, refunds and disputes? | A 3% fee on a $4,000 ring is a real cost. Margin is only true once processing is counted. |
| **Bank and card statements** | Did the money that was rung up actually arrive? | Unmatched deposits are the first sign of a drawer problem, a missed payout or fraud. |
| **Accounting** | Do the books agree with the store? | Month-end close stops being a weekend of spreadsheets, and the accountant gets a clean trail. |
| **Metal prices** | What is this inventory worth today, at melt and at retail? | Gold moves weekly. Repricing 140 pieces at the right moment protects margin; buying from the public too close to melt erodes it. |
| **Financing** | Which customers buy bigger when they can pay over time? | Financing lifts average ticket on bridal. Knowing who used it and who was declined shapes the next offer. |
| **Messages, email and calls** | Who asked for what, and did anyone answer? | A missed call about a custom order is lost revenue. Response time is a sales metric. |
| **CRM and marketing** | Which campaigns brought buyers, not just clicks? | Marketing spend gets judged by the sales it brought in, so the owner can repeat what worked and cut what didn't. |
| **Diamond and vendor feeds** | What can I source, and at what cost, for the customer in front of me? | Custom quotes go out the same day, priced from real availability. |

### Connected today

These are built, tested against recorded vendor responses, and run read-only. The table is generated from the [integration catalog](docs/integrations.md), so it names exactly what is built.

<!-- connected:start -->
<!-- Generated from the integration catalog by npm run progress:write. Edit the catalog, not this block. -->

| System | What the business gets | Feeds |
| --- | --- | --- |
| Shopify | Imports five years of orders, refunds and fulfillments, then keeps them current as orders change | Sales, Inventory, Clienteling, Marketing |
| Inventory and POS systems | Imports item lists, stock counts, customer lists and sales from any POS that exports CSV | Sales, Inventory, Clienteling, Marketing |
| Stripe | Imports five years of charges, refunds, disputes and payouts, then keeps them current from Stripe's events | Sales, Finance, Clienteling |
| Chase business bank accounts and credit cards | Imports six years of Chase business checking, savings and credit card activity from CSV downloads, PDF statements or both | Finance, Compliance |
| Bank and credit card statements (any bank) | Imports six years of bank and credit card transactions from any bank's CSV exports or PDF statements | Finance, Compliance |
| HubSpot | Imports five years of contacts, companies, deals, tickets and logged calls, emails, meetings, notes and tasks | Clienteling, Sales, Marketing |
| Monday.com | Imports five years of items from every board you can see, such as custom orders, repairs and production jobs, then keeps them current | Repairs, Custom orders, Sales |
| Custom forms | Imports five years of appointment requests, repair intake and custom order requests from Typeform, then keeps them current | Clienteling, Repairs, Custom orders |
| Gmail | Imports five years of mail metadata from one mailbox: who wrote to whom, when, which thread and which labels | Clienteling, Buying, Custom orders |
| Google Workspace and Drive | Imports the names, types, folders, sizes and edit times of the files in the folder the business shares, then keeps up with every change | Finance, Compliance |
| Slack | Imports five years of messages and threads from the channels the KaratOS app is invited to, and nothing else | Sales, Repairs, Custom orders |
| Square | Imports five years of orders, payments and refunds from every location, then keeps them current | Sales, Inventory, Clienteling, Repairs |
| Clover | Imports five years of Clover orders, payments and refunds, then keeps them current as they change | Sales, Inventory, Clienteling, Repairs |
| WooCommerce | Imports five years of orders and refunds and the whole catalog, then keeps them current | Sales, Inventory, Clienteling, Marketing |
| BigCommerce | Imports five years of orders, refunds, products and customers, then keeps them current | Sales, Inventory, Clienteling, Marketing |
| Wix | Imports five years of orders and the whole catalog, stock and contact list, then keeps them current | Sales, Inventory, Clienteling, Marketing |
| RapNet and the Rapaport Price List | Reads the Rapaport Price List for round and pear diamonds every week it is published | Buying, Inventory, Appraisals, Wholesale |
| IDEX Online | Reads the diamonds the business offers from the IDEX network, with grades, measurements and its own asking prices | Buying, Inventory, Appraisals, Wholesale |
| GIA Report Results | Confirms each GIA certificate number the business holds, with shape, carat weight, color, clarity, cut and proportions | Appraisals, Inventory, Buying |
| Metals-API | Keeps gold, silver, platinum and palladium spot prices current, in dollars per troy ounce | Metals, Buying |
| Klaviyo | Imports every profile, list, segment, campaign and flow, then keeps them current | Marketing, Clienteling |
| Twilio | Imports five years of the store's texts, WhatsApp messages and calls: who, when, which line and how each one ended | Clienteling, Repairs, Marketing |
| QuickBooks Online | Imports six years of invoices, bills, payments and journal entries, with the chart of accounts, customers and vendors | Finance, Compliance |
| Xero | Imports six years of invoices, bills, credit notes, payments, bank transactions and manual journals, with the chart of accounts and contacts | Finance, Compliance |
| Plaid | Imports up to two years of bank and card transactions from a bank linked through Plaid | Finance, Compliance |
| Authorize.net | Imports five years of settlement batches and the card and eCheck transactions in them, then keeps them current | Sales, Finance |
| Affirm | Imports five years of Affirm financed orders, refunds, disputes and daily settlements, then keeps them current | Sales, Finance |
| EDI with retail partners (X12 850, 855, 856, 810, 846, 852) | Imports two years of purchase orders (850), inventory reports (846) and sell-through (852) from retail partners | Inventory, Sales, Wholesale |
| TheWatchSearch (by TheWatchCloud) | Turns the dealer WhatsApp groups the store is in into a feed of offers: brand, reference, buy or sell, price, year, condition and set | Buying, Sales, Inventory |
<!-- connected:end -->

### Landing next

Each of these is built and in review, one connector at a time, so each can ship on its own:

- **Store and POS:** Square, Clover, WooCommerce, BigCommerce and Wix, so a store on any common platform gets the same picture.
- **Financing:** Affirm, so financed sales show up next to the payment that settled them.
- **Metal prices:** live spot prices, so inventory and gold-buying offers are valued at today's market.
- **Customers and conversations:** HubSpot, Gmail, Google Workspace, Slack, Twilio calls and texts, and web forms, so every inquiry and follow-up is counted.
- **Marketing and operations:** Klaviyo and monday.com, so campaign results and bench work are tied to the sales they produced.

The [roadmap](docs/roadmap.md) has the full sequence, including jewelry POS systems, diamond feeds and manufacturing.

## How we'll know it works

We judge KaratOS by what changes in the store, not by how many recommendations it makes. These are the measures for the first pilots. They are targets, not results yet.

| Measure | What it shows | Pilot target |
| --- | --- | --- |
| Recommendations accepted | The advice is worth acting on | Half or more of recommendations accepted or adjusted, not rejected |
| Time to first useful recommendation | Value on day one | Within an hour of connecting the first system |
| Aged inventory acted on | Cash released from the case | Every piece over 270 days reviewed within the first month |
| Repairs and custom orders past their promise date | Promises kept | Every late job flagged before the customer calls |
| Unreconciled deposits | Cash that reached the bank | Every gap between sales and deposits explained at month end |
| Cash reporting deadlines | Compliance risk | No Form 8300 deadline missed |

Every accept, reject and override is stored, so these numbers come from the system itself rather than a survey.

## Holiday pilot

The weeks before Black Friday decide a jeweler's year, so that is when KaratOS has to prove itself. We are running an open testing weekend on **November 21–22, 2026**, the weekend before Black Friday, with sign-ups open from November 16.

- **For jewelers:** connect your store, POS or bank in read-only mode and get your first list of recommendations before the holiday rush. Nothing in your systems is changed.
- **For developers:** every connector runs against recorded vendor responses, so you can run the full suite offline with `npm test` and help us break things before stores rely on them.

Sign up with the pilot form on the KaratOS website, or open an issue here to join as a tester.

## Progress

This section updates itself as work lands: it is generated from [docs/milestones.json](docs/milestones.json) and the [integration catalog](docs/integrations.md), and a test fails if it falls behind. Targets are estimates and move as priorities change.

<!-- progress:start -->
<!-- Generated from docs/milestones.json and the integration catalog by npm run progress:write. Edit those, not this block. -->

**Overall: 68% complete**, 26 of 38 roadmap items done. 29 of the 232 systems in the integration catalog are connected.

| Milestone | What it gives a jeweler | Progress | Target |
| --- | --- | --- | --- |
| Foundation | Every record is validated, stored once and traceable to its source. | ██████████ 100% | Done |
| Retail departments | Eleven departments that turn store data into daily recommendations. | ███████░░░ 67% | Dec 2026 |
| Core integrations | Connects what most jewelers already run: online store, POS, payments, bank and books. | ██████████ 100% | Done |
| Client instances | Each business gets its own isolated instance, in accounts it owns. | ████████░░ 75% | Dec 2026 |
| AI reasoning | Claude explains each recommendation in plain language and learns from the owner's decisions. | ░░░░░░░░░░ 0% | Jan 2027 |
| Self-serve AI dashboards | Owners ask a question and get a dashboard, without a developer. | ███░░░░░░░ 33% | Mar 2027 |
| Self-hosted and managed plans | Run it yourself for free, or let us host it on the premium plan. | ███░░░░░░░ 33% | Mar 2027 |
| Integrations, next wave | Jewelry POS, CRM, messaging, marketing and diamond feeds join the catalog. | █████████░ 89% | Jun 2027 |
| Manufacturing departments | Bench, casting and setting work tracked with metal loss and labor cost per piece. | ░░░░░░░░░░ 0% | Jun 2027 |

### Up next

- **Retail departments** (target Dec 2026): Tune thresholds against a live store's data
- **Client instances** (target Dec 2026): First live client instance
- **AI reasoning** (target Jan 2027): Claude-powered reasoner with provenance and confidence; Owner feedback tunes future recommendations; Semantic search over the business's documents
<!-- progress:end -->

The [roadmap](docs/roadmap.md) has the detail behind each milestone, and the [changelog](CHANGELOG.md) lists what shipped.

## What it covers

Brain A, the engine inside KaratOS, models each part of the business as a **department**. Every department runs through the same seven layers and reads what the other departments have learned.

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

Every recommendation carries a confidence score, its expected impact, and links to the exact events and signals behind it. Check those links before acting. Compliance items are reminders for the owner, not legal advice.

### Configuring departments per business

Turn on only the departments the business runs, with one setting:

```bash
# A full-service retail store
ENABLED_DEPARTMENTS=            # empty means every retail department

# A repair-focused shop
ENABLED_DEPARTMENTS=sales,repairs,clienteling,compliance

# An online-only brand
ENABLED_DEPARTMENTS=sales,inventory,marketing,finance
```

A department turned on later reads everything already in memory, so it is useful on its first day. The [departments guide](docs/departments/README.md) lists every rule, threshold and event.

## What's possible when the systems are connected

Each connected system adds context to the others, so the value grows with every connection. A customer, product or order becomes one record, whichever system it came from.

| Connected | What becomes visible |
| --- | --- |
| POS only | What sold and what sits |
| + online store | Total demand across channels, and which pieces only sell in person |
| + repairs | Which customers come back, and which styles keep breaking |
| + bank statements | True margin after card fees, refunds and metal costs |
| + email and messages | Why customers buy, and what they asked for that you didn't have |

Some insights appear only when departments share signals. These are built today:

- **Cash at the counter becomes compliance.** Sales records the cash, compliance tracks the Form 8300 deadline and watches for split payments, and finance checks that it reached the bank.
- **A gold price move becomes a pricing review.** Metals sees the spot change, inventory values aged gold pieces at melt, and gold buying flags offers that are too close to melt.
- **An anniversary becomes a sale.** Clienteling knows the date and the customer's wish list, and reaches out only to customers who agreed to marketing.
- **Sell-through drives reorders.** Sales feeds inventory, which recommends reordering what moves and marking down what sits.

These come next, as more connectors and reasoners are built:

- **A repair pattern becomes a buying decision.** If a style keeps coming back for the same fix, flag the vendor and stop reordering it.
- **A gold spike becomes a cash plan.** Heavy buying from the public plus a falling price becomes a finance alert.
- **The owner's judgment teaches the system.** Every accept, reject or override is already stored with what happened next. That history will then tune which advice the system trusts.

[Why Brain A gets more valuable over time](docs/vision/compounding-value.md) explains each of these mechanisms and the code behind it.

## How it works

Every piece of data passes through seven layers, in order. No layer is skipped.

1. **Event Ingestion:** raw source data becomes an immutable, validated event with an idempotency key. Invalid input is dead-lettered with the failing field, never dropped.
2. **Entity Normalization:** events map onto canonical entities: customer, product, order, payment and supplier.
3. **Signal Extraction:** typed observations derived from entities, traceable back to their events.
4. **Memory + State:** durable storage for events, entities, signals and decisions.
5. **Reasoning:** recommendations with confidence, expected impact and provenance.
6. **Feedback + Learning:** human accept, reject or override decisions are recorded as first-class signals.
7. **Documentation:** reasoning checks the current docs and marks itself *degraded* when they are stale.

See [docs/architecture/overview.md](docs/architecture/overview.md) for details.

[Integrations](docs/integrations.md) lists all the systems in the catalog, and [the website guide](docs/website.md) covers the public site.

## Quick start

You need Node 22 or later.

```bash
npm ci                       # install exactly what the lockfile pins
npm test                     # every test runs offline, against embedded Postgres
cp .env.example .env.local
npm run secrets:setup        # generates keys, then asks for the rest one at a time
npm run supabase:check       # explains a 401 or 404 before you migrate
npm run db:migrate
```

Run `npm run secrets:plan` to see which settings are still missing, without printing any value.

## One instance per client

Each business runs its own instance: its own Supabase project, container, API key and private deploy repo, all on the same public image. An instance serves exactly one organization and refuses events for any other. See [docs/deployment/instances.md](docs/deployment/instances.md).

Your data stays yours. On the Core plan, the database, the container and every credential sit in accounts the business owns, so once setup is done we have no access to any of it. On the Managed plan we host the instance for the business, still isolated from every other client, and reach it only to keep it running and add integrations. See [docs/open-core.md](docs/open-core.md#your-instance-your-data).

The instance API:

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness check, no key needed |
| `POST /v1/events` | Ingest one event; a replay with the same idempotency key is never stored twice |
| `POST /v1/reason` | Run the reasoners and return recommendations |
| `GET /v1/recommendations` | Latest recommendations, with provenance |
| `POST /v1/recommendations/:id/feedback` | Record an accept, reject or override |
| `GET /v1/entities/:kind/:id` | One canonical entity |
| `GET /v1/integrations` | Each catalog integration and whether this instance has its settings, by name only |

## Connectors

An instance syncs every connector listed in `ENABLED_INTEGRATIONS` on a schedule, history first and then incrementally ([how](docs/integrations.md#syncing-on-a-schedule)). Connectors are read-only by default. A connector may declare write actions, but `WriteGate` refuses every write that is not listed in `ENABLED_WRITES`, and it audits every attempt. We never request write scopes from a vendor.

Every connector must:

- Run a historical import, an incremental sync and webhooks through `runSync`, resume exactly from its checkpoint, and retry from that checkpoint.
- Produce events in the shape of the department that owns them, and keep only what departments use. No email addresses, phone numbers or street addresses.
- Ship tests built with `@karatos/connector-testkit`: synthetic fixtures, recorded responses with secrets scrubbed, a full import, replay, resume and retry run, and a check that the write gate refuses writes.
- Pass the nightly sandbox run (`npm run sandbox:run`) against the vendor's free test account, once one is configured. A failure opens an issue naming the connector and the step.

Systems we can't reach yet are tested against mocks built from the vendor's docs. The daily vendor docs watch (`npm run docs:watch`) checks each vendor's API changelog and every page a mock was built from, and opens an issue when one changes.

The Shopify connector is the first one built. See [docs/integrations.md](docs/integrations.md#shopify) for what it reads and how to connect a store.

## Packages

| Package | What it is |
| --- | --- |
| `@karatos/core` | Event envelope, layer contracts, pipeline, connector contract and `runSync`, write gate, integration catalog, in-memory store, jewelry math (karat purity, melt value), config validation |
| `@karatos/retail` | Retail jewelry departments: sales, inventory, clienteling, repairs, custom orders, appraisals, buying, metals, marketing, finance, compliance. See [departments](docs/departments/README.md) |
| `@karatos/store-postgres` | Postgres/Supabase `MemoryStore`, ingestion log and write audit, migration runner |
| `@karatos/connectors` | Built connectors, starting with Shopify |
| `@karatos/connector-testkit` | Shared connector test helpers: fixtures, replay, the `runSync` harness, webhook signing, doc mocks |
| `@karatos/server` | HTTP API for one client instance, shipped as the `ghcr.io/aasimsayani/karatos-brain` image |

The database schema lives in [`supabase/migrations`](supabase/migrations). See the [Supabase setup runbook](docs/runbooks/supabase-setup.md). The public website lives in [`site/`](site).

## Open core

The core is MIT-licensed and stays open. The Brain Console and some vertical modules ship under a commercial license. See [docs/open-core.md](docs/open-core.md).

## Security

This repository is public. Treat everything you commit here as published.

- Never commit a secret, customer data, a bank statement, or anything specific to one client. Client specifics belong in that client's private instance repo; values belong in `.env.local` or a host's secret store.
- Every secret and setting an instance needs is described, without its value, in [`secrets/manifest.json`](secrets/manifest.json), generated from [`secrets/manifest/`](secrets/manifest/). Follow [docs/secrets.md](docs/secrets.md) to add one.
- Use test-only sandbox accounts for connector tests, never a client's.
- CI runs `npm run secrets:scan` on every push.
- How the code, the instance API, the website and CI are protected, and what each guard is for, is in [docs/security.md](docs/security.md). Report a vulnerability privately as [SECURITY.md](SECURITY.md) describes.

## Contributing

Before you push, run:

```bash
npm run secrets:scan
npm run typecheck
npm run test:coverage        # fails under 90% lines, functions and statements, or 85% branches
```

- Every behavior change needs a test, and every security control needs one that fails if the control is removed. The break-it check on each PR includes security mutations; see [docs/security.md](docs/security.md#the-break-it-check).
- Every behavior change needs a test. A database change needs a migration and a test that runs it against PGlite.
- Add a changelog fragment, `changelog.d/<branch>.md`, and update the relevant doc in the same PR. Don't edit `CHANGELOG.md` directly; see [changelog.d/README.md](changelog.d/README.md).
- When a change finishes a roadmap item, mark it done in [docs/milestones.json](docs/milestones.json) and run `npm run progress:write`. Items tied to an integration update on their own once the catalog marks it built.
- `npm run prs:plan` prints the order to merge the open PRs in and what each waits on. After a PR merges, run `scripts/sync-open-prs.sh` to bring main into every other open PR, base PRs before the PRs stacked on them. It merges rather than rebases, regenerates the progress section and the connector registry, and pushes only after the checks pass. See [CONTRIBUTING.md](CONTRIBUTING.md#merging-prs-in-order).
- Adding a connector touches only its own files; `npm run registry:write` regenerates every shared list. See [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-connector).

AI agents working in this repo must read [AGENTS.md](AGENTS.md) first.

## License

[MIT](LICENSE)
