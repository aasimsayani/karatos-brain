<h1 align="center">KaratOS</h1>

<p align="center"><strong>The open-source brain for jewelry businesses.</strong><br>
It reads the systems you already run, sees what none of them can see alone, and hands each department a short list of what to do today.</p>

<p align="center">
  <a href="https://karatos.app/demo/">Live demo</a> ·
  <a href="https://karatos.app/">Website</a> ·
  <a href="docs/integrations.md">Integrations</a> ·
  <a href="docs/roadmap.md">Roadmap</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

### A morning at a store running KaratOS

> **Metals** · Gold is up 6%. Review prices on 140 gold pieces in the case.
>
> **Repairs** · Repair R-1042 is 4 days past the date the customer was promised. Call them today, before they call you.
>
> **Compliance** · A $14,900 sale was paid in cash. File IRS Form 8300 within 15 days.
>
> **Finance** · Cash sales are $1,200 more than the cash deposited this month. Reconcile the drawer.
>
> **Clienteling** · Two callers didn't get through this week and nobody called them back.

Most of these need two systems read together. The gold move comes from a metals price feed and the 140 pieces from the POS. The cash gap needs the POS and the bank side by side. The Form 8300 needs the sale, the payment type and the date. KaratOS reads them as one, and every item links to the exact records behind it, so you can check before you act. *(The numbers are made up. See them live in the [demo store](docs/demo.md).)*

**Who it's for:** independent jewelers with one to five stores, online and hybrid jewelry brands, and studios where repairs and custom work carry the business. Anyone who already runs good systems and still decides by feel, because no one system sees the whole store.

## Why KaratOS

A jewelry store is a showroom, a repair bench, a custom studio, a gold buyer, an appraiser and a back office under one roof, each on its own system or on paper. Money leaks in the gaps:

- **Inventory sits** for a year while gold moves, and nobody reprices or remakes it.
- **Promises slip.** Repairs and custom orders run past the date the customer was given.
- **Cash drifts.** Sales, deposits and card fees never get matched, so true margin is a guess.
- **Deadlines hide.** A cash sale over $10,000 needs a Form 8300 within 15 days, and nobody is tracking it.
- **Customers go quiet.** Anniversaries and wish lists live in a notebook instead of a reminder.

What you get in return:

- **Read-only by default.** KaratOS reads your systems and never changes them unless you turn on a specific action.
- **Your data stays yours.** Each business runs its own isolated instance. Self-host it for free, or let us host it.
- **Gets sharper with every system you add.** POS alone shows what sells. Add the bank and the books, and it shows true margin and cash that never reached the bank.
- **Learns from you.** Every accept, reject and adjustment is kept, so the advice gets better.

<details>
<summary><strong>The question each kind of connection answers</strong></summary>

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

</details>

## What happens when systems are read together

These cross-department plays are built today:

- **Cash at the counter becomes compliance.** Sales records the cash, compliance tracks the Form 8300 deadline and watches for split payments, and finance checks that it reached the bank.
- **A gold price move becomes a pricing review.** Metals sees the spot change, inventory values aged gold pieces at melt, and gold buying flags offers that are too close to melt.
- **An anniversary becomes a sale.** Clienteling knows the date and the customer's wish list, and reaches out only to customers who agreed to marketing.
- **Late invoices become a follow-up list.** Finance reads open invoices from the books, totals what is more than 30 days past due, and lists the customers to call, oldest first.
- **A missed call gets a callback.** Clienteling sees calls and texts and flags callers nobody got back to within the week.

<details>
<summary><strong>More plays, and what comes next</strong></summary>

- **Sell-through drives reorders.** Sales feeds inventory, which recommends reordering what moves and marking down what sits. *(Built.)*
- **A repair pattern becomes a buying decision.** If a style keeps coming back for the same fix, flag the vendor and stop reordering it. *(Next.)*
- **A gold spike becomes a cash plan.** Heavy buying from the public plus a falling price becomes a finance alert. *(Next.)*
- **The owner's judgment teaches the system.** Every accept, reject or override is already stored with what happened next. That history will then tune which advice the system trusts. *(Next.)*

| Connected | What becomes visible |
| --- | --- |
| POS only | What sold and what sits |
| + online store | Total demand across channels, and which pieces only sell in person |
| + repairs | Which customers come back, and which styles keep breaking |
| + bank statements | True margin after card fees, refunds and metal costs |
| + email and messages | Why customers buy, and what they asked for that you didn't have |

[Why Brain A gets more valuable over time](docs/vision/compounding-value.md) explains each of these and the code behind it.

</details>

## How it works

```
 Your systems (read-only)        One store              Eleven departments         You
 POS, Shopify, payments,   ──▶   every sale, repair,  ──▶  sales, repairs, metals,  ──▶  accept, reject
 bank, books, CRM, calls,        payment and bank line     finance, compliance ...      or adjust
 diamond feeds                   as one record             each with evidence           (it learns)
```

Every piece of data passes through the same seven layers, in order, and none is skipped: ingestion, normalization, signals, memory, reasoning, feedback and documentation. Each recommendation carries a confidence score, its expected impact and links to the events behind it. See [docs/architecture/overview.md](docs/architecture/overview.md).

<details>
<summary><strong>The seven layers</strong></summary>

1. **Event Ingestion:** raw source data becomes an immutable, validated event with an idempotency key. Invalid input is dead-lettered with the failing field, never dropped.
2. **Entity Normalization:** events map onto canonical entities: customer, product, order, payment and supplier.
3. **Signal Extraction:** typed observations derived from entities, traceable back to their events.
4. **Memory + State:** durable storage for events, entities, signals and decisions.
5. **Reasoning:** recommendations with confidence, expected impact and provenance.
6. **Feedback + Learning:** human accept, reject or override decisions are recorded as first-class signals.
7. **Documentation:** reasoning checks the current docs and marks itself *degraded* when they are stale.

</details>

<details>
<summary><strong>The eleven departments, with an example from each</strong></summary>

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

Check the linked records before acting. Compliance items are reminders for the owner, not legal advice.

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

</details>

## What's built

**An honest note:** every integration below is built and tested against recorded vendor responses or mocks made from the vendor's own docs. None has run against a live client account yet. The first pilot stores will be the first live runs, and the trade systems that need a store's own account (IDEX, Nivoda, Stuller, GIA, RapNet) turn on with the first pilot that has one.

### Built so far

<details>
<summary><strong>Every system KaratOS can read today, and the departments it feeds</strong></summary>

The table is generated from the [integration catalog](docs/integrations.md), so it names exactly what is built.

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
| Lightspeed Retail | Imports five years of sales and returns from every outlet, with every product, stock level and customer, then keeps them current | Sales, Inventory, Clienteling, Repairs |
| Square | Imports five years of orders, payments and refunds from every location, then keeps them current | Sales, Inventory, Clienteling, Repairs |
| Clover | Imports five years of Clover orders, payments and refunds, then keeps them current as they change | Sales, Inventory, Clienteling, Repairs |
| WooCommerce | Imports five years of orders and refunds and the whole catalog, then keeps them current | Sales, Inventory, Clienteling, Marketing |
| BigCommerce | Imports five years of orders, refunds, products and customers, then keeps them current | Sales, Inventory, Clienteling, Marketing |
| Wix | Imports five years of orders and the whole catalog, stock and contact list, then keeps them current | Sales, Inventory, Clienteling, Marketing |
| RapNet and the Rapaport Price List | Reads the Rapaport Price List for round and pear diamonds every week it is published | Buying, Inventory, Appraisals, Wholesale |
| IDEX Online | Reads the diamonds the business offers from the IDEX network, with grades, measurements and its own asking prices | Buying, Inventory, Appraisals, Wholesale |
| Nivoda | Reads the diamonds a saved Nivoda search finds, with grades, measurements and prices | Buying, Inventory, Appraisals, Wholesale |
| Stuller | Reads every Stuller invoice from the last five years, with its lines, totals, status and tracking number | Buying, Custom orders, Inventory, Repairs |
| GIA Report Results | Confirms each GIA certificate number the business holds, with shape, carat weight, color, clarity, cut and proportions | Appraisals, Inventory, Buying |
| Metals-API | Keeps gold, silver, platinum and palladium spot prices current, in dollars per troy ounce | Metals, Buying |
| Birdeye | Imports five years of reviews from every site Birdeye gathers them from, then every new or changed review | Marketing, Clienteling |
| Klaviyo | Imports every profile, list, segment, campaign and flow, then keeps them current | Marketing, Clienteling |
| Twilio | Imports five years of the store's texts, WhatsApp messages and calls: who, when, which line and how each one ended | Clienteling, Repairs, Marketing |
| QuickBooks Online | Imports six years of invoices, bills, payments and journal entries, with the chart of accounts, customers and vendors | Finance, Compliance |
| Xero | Imports six years of invoices, bills, credit notes, payments, bank transactions and manual journals, with the chart of accounts and contacts | Finance, Compliance |
| Plaid | Imports up to two years of bank and card transactions from a bank linked through Plaid | Finance, Compliance |
| Authorize.net | Imports five years of settlement batches and the card and eCheck transactions in them, then keeps them current | Sales, Finance |
| Affirm | Imports five years of Affirm financed orders, refunds, disputes and daily settlements, then keeps them current | Sales, Finance |
| PIRO | Imports five years of PIRO manufacturing jobs: status, stage, style, order number, metal, dates and weights | Manufacturing, Inventory, Wholesale |
| EDI with retail partners (X12 850, 855, 856, 810, 846, 852) | Imports two years of purchase orders (850), inventory reports (846) and sell-through (852) from retail partners | Inventory, Sales, Wholesale |
| Calendly | Imports two years of appointments and the year ahead, such as bridal consultations, repair drop-offs and pickups, then keeps them current | Clienteling, Custom orders, Repairs |
| Avalara AvaTax | Imports five years of sales tax for every sale, return and purchase, then keeps it current as transactions are committed, voided or adjusted | Compliance, Finance |
| TaxJar | Imports five years of the sales and refunds recorded in TaxJar, from each source named, then the last 31 days again on each sync | Compliance, Finance |
| FinCEN Form 8300 cash reporting | Imports five years of Form 8300 filings: date filed, sales covered, cash, and the BSA Tracking ID or BSA ID | Compliance |
| Refiner and scrap settlement statements | Imports five years of refiner and scrap settlements: lots, metals, weights, assays, metal credited and fees | Metals, Finance |
| Gusto | Imports three years of processed payrolls with their gross pay, taxes, benefits and company debit | Finance, Compliance |
| Mailchimp | Imports every audience and subscriber, and five years of sent campaigns with their reports, then keeps them current | Marketing, Clienteling |
| Google Analytics 4 | Imports two years of daily website sessions, users and new users by channel and by source and medium, then keeps them current | Marketing, Sales |
| Google Ads | Imports two years of daily spend, impressions, clicks, conversions and conversion value for every campaign, then keeps them current | Marketing |
| Meta Ads | Imports two years of daily Facebook and Instagram ad spend, reach, clicks and purchases for every campaign, then keeps them current | Marketing |
| Etsy | Imports five years of Etsy orders, then reads every order changed since the last sync | Sales, Inventory, Marketing |
| eBay | Imports the two years of eBay orders that eBay keeps, then reads every order changed since the last sync | Sales, Inventory |
| Microsoft 365 Outlook mail and calendar | Imports five years of the mailbox's Inbox and Sent Items, then keeps up with every new, changed and removed message | Clienteling, Buying, Custom orders, Repairs |
| Microsoft Teams | Imports five years of one team's channel messages and replies, then keeps up with every new, edited and deleted one | Sales, Repairs, Custom orders |
| RingCentral | Imports two years of calls, texts and voicemail on the store's RingCentral line, then rereads the last day on each sync | Clienteling, Repairs, Sales |
| Quo (formerly OpenPhone) | Imports two years of calls and texts on every Quo line, then rereads the last day on each sync | Clienteling, Repairs, Sales |
| Zoom | Imports six months of the account's past meetings, then the last two days again on each sync | Clienteling, Custom orders, Sales |
| Gorgias | Imports five years of helpdesk tickets and every message on them, then reads only the tickets that changed on each sync | Clienteling, Sales, Repairs |
| Zendesk | Imports five years of helpdesk tickets and customers, then reads only what changed on each sync | Clienteling, Sales, Repairs |
| Yotpo reviews and loyalty | Imports five years of product and store reviews, then the reviews changed in the last two days on each sync | Marketing, Clienteling |
| Judge.me | Imports five years of product and store reviews, then the reviews posted or changed in the last two days on each sync | Marketing, Clienteling |
| Smile.io | Imports five years of loyalty customers and points transactions, then reads only what changed on each sync | Marketing, Clienteling |
| Trustpilot | Imports five years of Trustpilot reviews, then rereads the last 30 days each sync so replies and edits show up | Marketing, Clienteling |
| Pinterest | Imports every Pin the store has made, with its title, the page it links to and its 90-day and lifetime metrics | Marketing, Sales |
| TikTok | Imports every public video the store posted in the last two years, with its title, link, length and views, likes, comments and shares | Marketing |
| TikTok Ads | Imports two years of daily TikTok ad spend, impressions, reach, clicks and purchases for every campaign, then keeps them current | Marketing |
| Yext | Imports two years of reviews from Google, Yelp, Facebook and the other sites Yext watches, with the rating, an excerpt and where to answer it | Marketing, Clienteling |
| Amazon (Selling Partner API) | Imports two years of Amazon orders with their status, totals and lines, counted as sales next to the store and website | Sales, Inventory, Finance |
| Squarespace Commerce | Reads the whole catalog with each variant's price, sale price and stock, on every sync | Sales, Inventory, Clienteling, Marketing |
| HRD Antwerp report check | Confirms each HRD Antwerp report number the business holds, with shape, carat weight, color, clarity, cut, polish, symmetry and proportions | Appraisals, Inventory, Buying |
| Supplier invoices and memos | Imports six years of supplier invoice and memo lines: items, quantities, costs, memo terms and due dates | Buying, Inventory, Compliance, Finance |
| RFID and barcode tray counts | Imports two years of tray and case counts: what was read, when, and by whom | Inventory, Compliance |
| FedEx | Follows every FedEx package on the business's list, from label created to delivered or returned | Inventory, Repairs, Compliance |
| UPS | Follows every UPS package on the business's list, from label created to delivered or returned | Inventory, Repairs, Compliance |
| BILL | Imports six years of supplier bills with their due dates, balances, payment status and approval status | Finance, Buying |
| Ramp | Imports five years of company card transactions, then each one Ramp says changed since the last sync | Finance, Buying |
| NetSuite | Imports every item and vendor and six years of orders, invoices and journal entries, then what changed on each sync | Finance, Inventory, Manufacturing, Wholesale, Buying |
| Katana | Imports five years of manufacturing orders, then each one changed since the last sync, deleted ones as cancelled | Manufacturing, Inventory, Buying |
| Asana | Imports five years of tasks from every project you can see, such as repairs, custom orders and production jobs, then keeps them current | Repairs, Custom orders, Buying |
| Trello | Imports five years of cards from every board you can see, such as repairs, custom orders and buying, then keeps them current | Repairs, Custom orders, Buying |
| Airtable | Imports five years of records from every base you share, such as memo logs, repair intake and custom orders, then keeps them current | Repairs, Custom orders, Buying, Inventory |
| Notion | Imports five years of pages from every database you share, such as repairs, custom orders and buying, then keeps them current | Repairs, Custom orders, Buying |
| Docusign | Imports five years of agreements sent for signature, such as consignment and memo agreements, then keeps them current | Appraisals, Wholesale, Compliance, Custom orders |
| Dropbox | Imports the names, kinds, folders, sizes and edit times of the files in the folder you share, then keeps up with every change | Finance, Compliance, Custom orders |
| Microsoft OneDrive and SharePoint files | Imports the names, kinds, folders, sizes and edit times of the files in the library you share, then keeps up with every change | Finance, Compliance, Custom orders |
| Verkada store traffic | Imports two years of hourly people counts from every counting line, then the hours since the last sync | Sales, Marketing |
| e-Jewelry for Business Central | Imports every item and vendor and five years of sales and purchase invoices, then what changed on each sync | Inventory, Sales, Manufacturing, Wholesale, Finance, Metals |
| Sola Payments (formerly Cardknox) | Imports five years of card and check payments and refunds, then the last two days again on each sync | Finance, Sales |
| TheWatchSearch (by TheWatchCloud) | Turns the dealer WhatsApp groups the store is in into a feed of offers: brand, reference, buy or sell, price, year, condition and set | Buying, Sales, Inventory |
| Search The Watch Market Business API | Gives a fair market price for each reference the store follows: listings, low, high, mean and market value | Buying, Appraisals, Sales, Inventory |
| RepairShopr | Imports five years of repair tickets, estimates and invoices, then what changed | Repairs, Clienteling |
<!-- connected:end -->

</details>

### Landing next

- **The owner's money view.** Cash in each bank account, what is owed on cards, what customers owe and which invoices are more than 30 days late, on one screen in the Brain Console.
- **Live checks with pilot stores.** The trade connectors turn on with a pilot client's own account.
- **Jewelry POS and the next wave.** The Edge, Jewel360 and ARMS through their exports, then Podium, Valigara and Attentive as access arrives.
- **Plain-language reasoning.** Claude explains each recommendation and learns from the owner's accept, reject and override decisions.

## Progress

This section updates itself from [docs/milestones.json](docs/milestones.json) and the [integration catalog](docs/integrations.md), and a test fails if it falls behind. Targets are estimates and move as priorities change.

<!-- progress:start -->
<!-- Generated from docs/milestones.json and the integration catalog by npm run progress:write. Edit those, not this block. -->

**Roadmap:** 20 of 81 items done. An integration counts as done once it has run against a real or sandbox account, not when its tests pass.

**Integrations:** 84 of the 253 systems in the catalog are built and tested against mocks made from each vendor's docs. 0 have been checked live so far.

| Milestone | What it gives a jeweler | Progress | Target |
| --- | --- | --- | --- |
| Foundation | Every record is validated, stored once and traceable to its source. | ██████████ 100% | Done |
| Retail departments | Eleven departments that turn store data into daily recommendations. | ████████░░ 80% | Dec 2026 |
| Core integrations | Connects what most jewelers already run: online store, POS, payments, bank and books. | █░░░░░░░░░ 14% (6 of 6 built, 0 checked live) | Nov 2026 |
| Client instances | Each business gets its own isolated instance, in accounts it owns. | █████████░ 86% | Dec 2026 |
| Website and demo | Jewelers can see what KaratOS does for their business before they talk to us. | ██████░░░░ 60% | Nov 2026 |
| AI reasoning | Claude explains each recommendation in plain language and learns from the owner's decisions. | ░░░░░░░░░░ 0% | Jan 2027 |
| Self-serve AI dashboards | Owners ask a question and get a dashboard, without a developer. | ███░░░░░░░ 33% | Mar 2027 |
| Self-hosted and managed plans | Run it yourself for free, or let us host it on the premium plan. | ███░░░░░░░ 33% | Mar 2027 |
| Integrations, next wave | Jewelry POS, CRM, messaging, marketing and diamond feeds join the catalog. | ░░░░░░░░░░ 0% (19 of 19 built, 0 checked live) | Dec 2026 |
| Marketplaces, ads and office tools | Sales channels, ad spend and the files and tasks a team already keeps, in one place. | ░░░░░░░░░░ 0% (17 of 17 built, 0 checked live) | Dec 2026 |
| Shipping, payables and insurance | Packages, bills and care plans tracked next to the sale they belong to. | ░░░░░░░░░░ 0% (3 of 6 built, 0 checked live) | Jan 2027 |
| Manufacturing departments | Bench, casting and setting work tracked with metal loss and labor cost per piece. | ░░░░░░░░░░ 0% | Jun 2027 |

### Up next

- **Core integrations** (target Nov 2026): check live: Shopify, Inventory and POS systems, Stripe, Bank and card statements from CSV exports, Chase business bank accounts and credit cards, QuickBooks Online
- **Website and demo** (target Nov 2026): Demo walkthroughs of the biggest jeweler problems; Homepage video of the live dashboard solving real problems
- **Retail departments** (target Dec 2026): Tune thresholds against a live store's data
<!-- progress:end -->

The [roadmap](docs/roadmap.md) has the detail behind each milestone, and the [changelog](CHANGELOG.md) lists what shipped.

<details>
<summary><strong>How we'll know it works: the pilot measures</strong></summary>

We judge KaratOS by what changes in the store, not by how many recommendations it makes. These are targets for the first pilots, not results yet.

| Measure | What it shows | Pilot target |
| --- | --- | --- |
| Recommendations accepted | The advice is worth acting on | Half or more of recommendations accepted or adjusted, not rejected |
| Time to first useful recommendation | Value on day one | Within an hour of connecting the first system |
| Aged inventory acted on | Cash released from the case | Every piece over 270 days reviewed within the first month |
| Repairs and custom orders past their promise date | Promises kept | Every late job flagged before the customer calls |
| Unreconciled deposits | Cash that reached the bank | Every gap between sales and deposits explained at month end |
| Cash reporting deadlines | Compliance risk | No Form 8300 deadline missed |

Every accept, reject and override is stored, so these numbers come from the system itself rather than a survey.

</details>

## Holiday pilot: November 21–22, 2026

The weeks before Black Friday decide a jeweler's year, so that is when KaratOS has to prove itself. Sign-ups open November 16.

- **Jewelers:** connect your store, POS or bank in read-only mode and get your first list before the holiday rush. Nothing in your systems is changed.
- **Developers:** every connector runs offline against recorded responses or doc-built mocks, so `npm test` runs the whole suite. Help us break things before stores rely on them.

Sign up with the pilot form on the [KaratOS website](https://karatos.app/), or open an issue here to join as a tester.

## Getting started

**Just looking?** Open the [live demo](https://karatos.app/demo/): Example Street Jewelers, a made-up store running on the real connectors and the real brain. See [docs/demo.md](docs/demo.md).

**Running it yourself?** You need Node 22 or later.

```bash
npm ci                       # install exactly what the lockfile pins
npm test                     # every test runs offline, against embedded Postgres
cp .env.example .env.local
npm run secrets:setup        # generates keys, then asks for the rest one at a time
npm run supabase:check       # explains a 401 or 404 before you migrate
npm run db:migrate
```

Run `npm run secrets:plan` to see which settings are still missing, without printing any value.

<details>
<summary><strong>One instance per client</strong></summary>

Each business runs its own instance: its own Supabase project, container, API key and private deploy repo, all on the same public image. An instance serves exactly one organization and turns away events for any other. See [docs/deployment/instances.md](docs/deployment/instances.md).

On the Core plan, the database, the container and every credential sit in accounts the business owns, so once setup is done we have no access to any of it. On the Managed plan we host the instance for the business, still isolated from every other client, and reach it only to keep it running and add integrations. See [docs/open-core.md](docs/open-core.md#your-instance-your-data).

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness check, no key needed |
| `POST /v1/events` | Ingest one event; a replay with the same idempotency key is never stored twice |
| `POST /v1/reason` | Run the reasoners and return recommendations |
| `GET /v1/recommendations` | Latest recommendations, with provenance |
| `POST /v1/recommendations/:id/feedback` | Record an accept, reject or override |
| `GET /v1/entities/:kind/:id` | One canonical entity |
| `GET /v1/signals` | The latest signals, filtered by kind, such as each bank balance or open invoice |
| `GET /v1/integrations` | Each catalog integration and whether this instance has its settings, by name only |

</details>

<details>
<summary><strong>How connectors work</strong></summary>

An instance syncs every connector listed in `ENABLED_INTEGRATIONS` on a schedule, history first and then incrementally ([how](docs/integrations.md#syncing-on-a-schedule)). Connectors are read-only by default. A connector may declare write actions, but `WriteGate` blocks every write that is not listed in `ENABLED_WRITES`, and it audits every attempt. We never request write scopes from a vendor.

Every connector must:

- Run a historical import, an incremental sync and webhooks through `runSync`, resume exactly from its checkpoint, and retry from that checkpoint.
- Produce events in the shape of the department that owns them, and keep only what departments use. No email addresses, phone numbers or street addresses.
- Ship tests built with `@karatos/connector-testkit`: synthetic fixtures, recorded responses with secrets scrubbed, a full import, replay, resume and retry run, and a check that the write gate blocks writes.
- Pass the nightly sandbox run (`npm run sandbox:run`) against the vendor's free test account, once one is configured. A failure opens an issue naming the connector and the step.

Systems we can't reach yet are tested against mocks built from the vendor's docs. The daily vendor docs watch (`npm run docs:watch`) checks each vendor's API changelog and every page a mock was built from, and keeps one ranked checklist issue of the vendors whose docs changed, with the ones clients use first.

The Shopify connector was the first one built. See [docs/integrations.md](docs/integrations.md#shopify) for what it reads and how to connect a store. [Integration research](docs/research/README.md) records what each vendor's own docs say about API access, sign-up and test environments, with a source for every claim.

</details>

<details>
<summary><strong>Packages</strong></summary>

| Package | What it is |
| --- | --- |
| `@karatos/core` | Event envelope, layer contracts, pipeline, connector contract and `runSync`, write gate, integration catalog, in-memory store, jewelry math (karat purity, melt value), config validation |
| `@karatos/retail` | Retail jewelry departments: sales, inventory, clienteling, repairs, custom orders, appraisals, buying, metals, marketing, finance, compliance. See [departments](docs/departments/README.md) |
| `@karatos/store-postgres` | Postgres/Supabase `MemoryStore`, ingestion log and write audit, migration runner |
| `@karatos/connectors` | Every built connector, one folder each, from Shopify and QuickBooks to IDEX, Nivoda and Stuller |
| `@karatos/connector-testkit` | Shared connector test helpers: fixtures, replay, the `runSync` harness, webhook signing, doc mocks |
| `@karatos/server` | HTTP API for one client instance, shipped as the `ghcr.io/aasimsayani/karatos-brain` image |

The database schema lives in [`supabase/migrations`](supabase/migrations). See the [Supabase setup runbook](docs/runbooks/supabase-setup.md). The public website lives in [`site/`](site), and [the website guide](docs/website.md) covers it.

</details>

## Contributing

We'd love the help, especially from people who know jewelry systems. Before you push, run:

```bash
npm run secrets:scan
npm run typecheck
npm run test:coverage        # fails under 90% lines, functions and statements, or 85% branches
```

- Every behavior change needs a test, and every security control needs one that fails if the control is removed. See [docs/security.md](docs/security.md#the-break-it-check).
- Add a changelog fragment, `changelog.d/<branch>.md`, and update the relevant doc in the same PR. See [changelog.d/README.md](changelog.d/README.md).
- Adding a connector touches only its own files. See [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-connector).

<details>
<summary><strong>More for contributors</strong></summary>

- A database change needs a migration and a test that runs it against PGlite.
- Don't edit `CHANGELOG.md` directly; it is built from the fragments.
- When a change finishes a roadmap item, mark it done in [docs/milestones.json](docs/milestones.json) and run `npm run progress:write`. Items tied to an integration update on their own once the catalog marks it built.
- `npm run registry:write` regenerates every shared list after a connector is added.
- `npm run prs:plan` prints the order to merge the open PRs in and what each waits on. After a PR merges, run `scripts/sync-open-prs.sh` to bring main into every other open PR, base PRs before the PRs stacked on them. It merges rather than rebases, regenerates the progress section and the connector registry, and pushes only after the checks pass. See [CONTRIBUTING.md](CONTRIBUTING.md#merging-prs-in-order).

AI agents working in this repo must read [AGENTS.md](AGENTS.md) first.

</details>

## Security

This repository is public. Never commit a secret, customer data, a bank statement, or anything specific to one client.

<details>
<summary><strong>How secrets and data are handled</strong></summary>

- Client specifics belong in that client's private instance repo; values belong in `.env.local` or a host's secret store.
- Every secret and setting an instance needs is described, without its value, in [`secrets/manifest.json`](secrets/manifest.json), generated from [`secrets/manifest/`](secrets/manifest/). Follow [docs/secrets.md](docs/secrets.md) to add one.
- Use test-only sandbox accounts for connector tests, never a client's.
- CI runs `npm run secrets:scan` on every push.
- Raw vendor payloads are cleared after 30 days; the facts drawn from them, and the links back to their source, stay.
- How the code, the instance API, the website and CI are protected is in [docs/security.md](docs/security.md).

</details>

Report a vulnerability privately as [SECURITY.md](SECURITY.md) describes.

## Open core and license

The core is [MIT](LICENSE)-licensed and stays open. The Brain Console and some vertical modules ship under a commercial license. See [docs/open-core.md](docs/open-core.md).
