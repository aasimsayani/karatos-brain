# Integrations

The catalog lives in code at [`packages/core/src/integrations.ts`](../packages/core/src/integrations.ts). The first entries come from the original Brain A Integration Mapping sheet; the rest cover the wider stack that jewelry retailers, wholesalers and manufacturers run. A built connector's own catalog fields (status, note, capabilities and anything else it settles) are in `packages/core/src/catalog/<id>.ts`, next to nothing else. Tests check two things: every setting an integration needs is documented in [`secrets/manifest.json`](../secrets/manifest.json), and every integration appears in the tables below, which are generated from the catalog by `npm run registry:write`.

`integrationsFor("retail" | "wholesale" | "manufacturing")` returns the systems a given kind of business is likely to run, which is where onboarding starts.

## Build order: self-serve first

The first phase builds every integration we can finish without asking any vendor, company or person for anything: a public API with a free developer sandbox, or a file or EDI format we can test with synthetic samples. `selfServeIntegrations()` returns that list (37 systems today). Systems that need a paid subscription, a trade account or a partnership come later, once the core is built out.

Which vendors offer a free sandbox is our current understanding as of October 2026. Confirm it when signing up for each developer account.

## How each system can be reached

| Access | Meaning | What a connector does |
| --- | --- | --- |
| Public API | Documented API the business can authorize on its own | Historical import, incremental sync and webhooks where offered |
| Partner | An API exists but needs a vendor partnership or approval | Start from scheduled exports while the partnership is set up |
| EDI | X12 or XML documents through a VAN, AS2 or SFTP | Parse purchase orders, ship notices, invoices, inventory (846) and sell-through (852) |
| File export | Exports or statements are the only route today | Import CSV or PDF on a schedule through the same pipeline |
| Unknown | No access route confirmed yet | Ask the vendor; fall back to exports |

Most jewelry-specific POS systems (The Edge, Jewel360, ARMS) publish no public API, so exports come first for them. Diamond networks (RapNet, IDEX, Nivoda) list many of the same stones, so connectors match stones on the grading lab and report number before counting inventory.

## Catalog

Used by: R is retail, W is wholesale, M is manufacturing. Test with says how we test the connector without a client's real account. Access details for vendors marked Partner or Unknown still need confirming with the vendor before a connector is built.

<!-- registry:catalog:start -->
<!-- Generated from packages/core/src/integrations.ts and each connector's packages/core/src/catalog/<id>.ts by npm run registry:write. Edit those, not this block. -->

### Point of sale and e-commerce

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| Shopify | R, W | Public API | Free sandbox | Yes | Built (Connector in @karatos/connectors: orders, refunds, fulfillments, products and customers, read-only) |
| Inventory and POS systems | R | File export | Sample files | No | Built (CSV exports from any POS, read through a column-mapping profile) |
| The Edge (Abbott Jewelry Systems) | R | Partner | Partner | No | Planned (No public API; partners use an on-premises connector. Start with scheduled exports) |
| Jewel360 | R | Partner | Partner | No | Planned (Partner integrations only. Start with exports) |
| ARMS | R | Unknown | Unknown | No | Planned |
| Lightspeed Retail | R | Public API | Unknown | Yes | Planned |
| Square | R | Public API | Free sandbox | Yes | Planned |
| Clover | R | Public API | Free sandbox | Yes | Built (Connector in @karatos/connectors: orders, payments, refunds, items, stock and customers, read-only. Clover can't report an app's permissions, so the connector sends only its listed GET requests) |
| Valigara | R, W, M | Unknown | Unknown | No | Planned |
| WooCommerce | R | Public API | Free sandbox | Yes | Planned |
| BigCommerce | R, W | Public API | Free sandbox | Yes | Planned |
| Wix | R | Public API | Free sandbox | Yes | Planned |
| Punchmark | R | Partner | Partner | No | Planned |
| Etsy | R, M | Public API | Unknown | No | Planned |
| eBay | R, W | Public API | Free sandbox | Yes | Planned (Estate and pre-owned pieces) |

### Diamonds, suppliers and grading

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| RapNet and the Rapaport Price List | R, W | Public API | Paid account | No | Planned (Price list needs an active subscription) |
| IDEX Online | R, W | Public API | Paid account | No | Planned |
| Nivoda | R, W | Public API | Unknown | No | Planned (GraphQL; holds and orders need the Pro API) |
| VDB (Virtual Diamond Boutique) | R, W | Partner | Partner | No | Planned |
| Polygon | R, W | Unknown | Unknown | No | Planned (Includes Memo-Track) |
| Stuller | R, M | Public API | Paid account | No | Planned (Product, gem, order and invoice APIs) |
| GemFind JewelCloud | R, W, M | Partner | Partner | No | Planned |
| Quality Gold | R | Unknown | Unknown | No | Planned |
| GIA Report Results | R, W, M | Public API | Paid account | No | Planned (Needs a GIA lab account) |
| IGI report verification | R, W | Unknown | Unknown | No | Planned (Web lookup only; no API found) |
| GemGuide Appraisal Software | R | Unknown | Unknown | No | Planned |

### Pricing

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| Geller's Blue Book | R | Partner | Partner | No | Planned (Repair pricing; reached through the POS today) |
| nFusion Solutions metals feed | R, W, M | Public API | Paid account | No | Planned |
| Metals-API | R, W, M | Public API | Free sandbox | No | Planned (No public API changelog; the nightly sandbox run catches API changes) |

### Customers, marketing and communication

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| HubSpot | R, W | Public API | Free sandbox | Yes | Built (Read scopes only; KaratOS checks the token's scopes before every sync and stops if one could change data. Pinned to HubSpot's 2026-09 API version, and the docs watch follows HubSpot's changelog) |
| Monday.com | R, W, M | Public API | Free sandbox | Yes | Built (Read-only: the connector only sends its own read queries, and a monday app token holding any write scope is turned away. A personal token can't be limited to reading, so a monday app token with boards:read and updates:read is the safer choice. The docs watch follows the API changelog, and the nightly run against a free developer account catches API changes) |
| Custom forms | R | Public API | Free sandbox | Yes | Built (Typeform forms through its Responses API, and signed submissions from any other form or website. Keeps only the mapped request details, never contact details or the customer's own words) |
| Gmail | R, W, M | Public API | Free sandbox | Yes | Built (Metadata scope only, which Google classes as restricted: an app outside one Workspace organization needs Google's verification before production use, and a consent screen left in Testing gives tokens that last seven days. Push through Pub/Sub isn't used; the scheduled sync reads the mailbox history) |
| Google Workspace and Drive | R, W, M | Public API | Free sandbox | Yes | Built (Read-only scopes only. drive.metadata.readonly is restricted: an app outside one Workspace organization needs Google's verification before production use, and a consent screen left in Testing gives tokens that last seven days. Push channels stay behind the write gate; the scheduled sync reads Drive's change feed and Calendar's sync tokens) |
| Slack | R, W, M | Public API | Free sandbox | Yes | Built (Bot token with read scopes only, as an internal app made in the business's own workspace. Since May 2025 an app distributed outside the Slack Marketplace may read history only once a minute, 15 messages at a time, so a five-year import needs the internal app. Events API webhooks are verified but the instance doesn't take them yet; the scheduled sync reads the same messages) |
| Instagram DMs, Facebook Messenger and WhatsApp Business | R | Public API | Free sandbox | Yes | Deferred (Waiting on Facebook account recovery) |
| Claude (Anthropic API) | R, W, M | Public API | Paid account | No | Planned (Reasoning, not a data source) |
| Clientbook | R | Partner | Partner | No | Planned |
| Podium | R | Public API | Unknown | Yes | Planned |
| Birdeye | R | Public API | Unknown | No | Planned |
| Klaviyo | R | Public API | Free sandbox | Yes | Planned |
| Attentive | R | Public API | Unknown | Yes | Planned |
| Twilio | R, W | Public API | Free sandbox | Yes | Planned |
| Calendly | R | Public API | Free sandbox | Yes | Planned (Appointments for consultations, bridal and repair drop-off) |
| Acuity Scheduling | R | Public API | Paid account | Yes | Planned |
| Mailchimp | R | Public API | Free sandbox | Yes | Planned |
| Google Analytics 4 | R, W | Public API | Free sandbox | No | Planned |
| Google Ads | R | Public API | Free sandbox | No | Planned (Test accounts for development; production needs an approved developer token) |
| Meta Ads | R | Public API | Free sandbox | No | Planned |
| Google Business Profile | R | Partner | Partner | No | Planned (Reviews and local listings; Google approves API access on request) |

### Money

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| Stripe | R, W | Public API | Free sandbox | Yes | Built (Connector in @karatos/connectors: charges, refunds, disputes, payouts, balance transactions and customers, read-only) |
| Chase business bank accounts and credit cards | R, W, M | File export | Sample files | No | Built (CSV activity downloads, PDF statements or both, read with Chase's own layouts) |
| Bank and credit card statements (any bank) | R, W, M | File export | Sample files | No | Built (CSV exports and PDF statements from any bank) |
| QuickBooks Online | R, W, M | Public API | Free sandbox | Yes | Built (Read-only, though Intuit has no read-only scope. Intuit's changelog (release notes) page needs JavaScript, so the docs watch reads the pages the mock was built from instead, and the nightly sandbox run catches API changes) |
| Xero | R, W, M | Public API | Free sandbox | Yes | Built (Read-only scopes only; the connector stops on a connection holding any other. The docs watch follows Xero's changelog, and the nightly run against the Demo Company catches API changes) |
| Plaid | R, W, M | Public API | Free sandbox | Yes | Built (Bank feeds beyond Chase: accounts, balances and transactions from one linked bank, read-only) |
| Authorize.net | R, W | Public API | Free sandbox | Yes | Built (Read-only, though an Authorize.net key can't be limited to reading: the connector sends Transaction Reporting requests only. The docs watch follows the API changelog, and the nightly sandbox run catches API changes) |
| Affirm | R | Public API | Free sandbox | Yes | Built (Read-only, though an Affirm key pair can't be limited to reading: the connector only sends GET requests for transactions, disputes and settlements. US accounts only for now. The docs watch follows the API changelog, and the nightly sandbox run catches API changes) |
| Synchrony | R | Partner | Partner | No | Planned |
| Acima | R | Partner | Partner | No | Planned |
| Jewelers Board of Trade | W, M | Partner | Partner | No | Planned (Trade credit ratings) |
| Avalara AvaTax | R, W, M | Public API | Free sandbox | No | Planned (Sales tax by jurisdiction. No public AvaTax changelog; the nightly sandbox run catches API changes) |
| TaxJar | R, W | Public API | Unknown | No | Planned |
| FinCEN Form 8300 cash reporting | R, W, M | File export | Sample files | No | Planned (Cash payments over $10,000; filed through BSA E-Filing, which has no API, so the brain prepares and tracks filings) |
| Refiner and scrap settlement statements | R, W, M | File export | Sample files | No | Planned (CSV or PDF from the refiner) |
| Gusto | R, W, M | Public API | Free sandbox | Yes | Planned (Payroll, commissions and staff costs) |

### Manufacturing and wholesale operations

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| PIRO | W, M | EDI | Sample files | No | Planned |
| Adaptive Jewelry ERP | R, W, M | Unknown | Unknown | No | Planned (Built on Microsoft Dynamics NAV) |
| Acumatica JewelShop | W, M | Public API | Unknown | Yes | Planned |
| DiamTrade | W, M | Unknown | Unknown | No | Planned |
| EDI with retail partners (X12 850, 855, 856, 810, 846, 852) | W, M | EDI | Sample files | No | Planned (Purchase orders, ship notices, invoices, inventory and sell-through) |
| Jewelers Mutual care plans | R | Public API | Partner | No | Planned |
| Parcel Pro | R, W, M | Partner | Partner | No | Planned |
| Malca-Amit | W, M | Partner | Partner | No | Planned |
| MatrixGold CAD | R, M | Unknown | Unknown | No | Planned (Custom design files and metal weight estimates) |
| Formlabs 3D printing | R, M | Unknown | Unknown | No | Planned (Print jobs for wax and resin models) |

<!-- registry:catalog:end -->

## Systems by department

Every department reads from more than one system, and a test keeps it that way. This is also where to look when adding a department: if it has fewer than two systems, the catalog is missing something.

| Department | Systems it reads from |
| --- | --- |
| Sales and POS | Shopify, Inventory and POS systems, Stripe, HubSpot, Monday.com, Slack, Instagram DMs, Facebook Messenger and WhatsApp Business, The Edge (Abbott Jewelry Systems), Jewel360, ARMS, Lightspeed Retail, Square, Clover, Valigara, WooCommerce, BigCommerce, Wix, Punchmark, Clientbook, Podium, Authorize.net, Affirm, Synchrony, Acima, EDI with retail partners (X12 850, 855, 856, 810, 846, 852), Jewelers Mutual care plans, Google Analytics 4, Etsy, eBay |
| Inventory and Merchandising | Shopify, Inventory and POS systems, The Edge (Abbott Jewelry Systems), Jewel360, ARMS, Lightspeed Retail, Square, Clover, Valigara, WooCommerce, BigCommerce, Wix, Punchmark, RapNet and the Rapaport Price List, IDEX Online, Nivoda, VDB (Virtual Diamond Boutique), Polygon, Stuller, GemFind JewelCloud, Quality Gold, GIA Report Results, IGI report verification, PIRO, Adaptive Jewelry ERP, Acumatica JewelShop, DiamTrade, EDI with retail partners (X12 850, 855, 856, 810, 846, 852), Parcel Pro, Malca-Amit, Etsy, eBay |
| Clienteling and CRM | Inventory and POS systems, HubSpot, Custom forms, Gmail, Instagram DMs, Facebook Messenger and WhatsApp Business, The Edge (Abbott Jewelry Systems), Jewel360, ARMS, Lightspeed Retail, Square, Clover, Clientbook, Podium, Birdeye, Klaviyo, Twilio, Calendly, Acuity Scheduling, Mailchimp, Google Business Profile |
| Repairs and Service | Monday.com, Custom forms, Slack, The Edge (Abbott Jewelry Systems), Jewel360, ARMS, Lightspeed Retail, Square, Clover, Stuller, Geller's Blue Book, Twilio, Jewelers Mutual care plans, Parcel Pro, Malca-Amit, Calendly, Acuity Scheduling |
| Custom and Special Orders | Monday.com, Custom forms, Gmail, Slack, Stuller, Quality Gold, Calendly, Acuity Scheduling, MatrixGold CAD, Formlabs 3D printing |
| Appraisals | RapNet and the Rapaport Price List, IDEX Online, Nivoda, VDB (Virtual Diamond Boutique), GIA Report Results, IGI report verification, GemGuide Appraisal Software |
| Buying, Vendors and Memo | Gmail, RapNet and the Rapaport Price List, IDEX Online, Nivoda, VDB (Virtual Diamond Boutique), Polygon, Stuller, GemFind JewelCloud, Quality Gold, GIA Report Results, nFusion Solutions metals feed, Metals-API, Jewelers Board of Trade, Adaptive Jewelry ERP, Acumatica JewelShop, DiamTrade |
| Metals and Gold Buying | nFusion Solutions metals feed, Metals-API, Refiner and scrap settlement statements |
| Marketing | Shopify, Inventory and POS systems, HubSpot, Instagram DMs, Facebook Messenger and WhatsApp Business, Valigara, WooCommerce, BigCommerce, Wix, Punchmark, GemFind JewelCloud, Podium, Birdeye, Klaviyo, Attentive, Twilio, Mailchimp, Google Analytics 4, Google Ads, Meta Ads, Google Business Profile, Etsy |
| Finance | Stripe, Chase business bank accounts and credit cards, Bank and credit card statements (any bank), Google Workspace and Drive, QuickBooks Online, Xero, Plaid, Authorize.net, Affirm, Synchrony, Acima, Jewelers Board of Trade, Avalara AvaTax, TaxJar, Refiner and scrap settlement statements, Gusto |
| Compliance | Chase business bank accounts and credit cards, Bank and credit card statements (any bank), Google Workspace and Drive, QuickBooks Online, Xero, Plaid, Jewelers Mutual care plans, Parcel Pro, Malca-Amit, Avalara AvaTax, TaxJar, FinCEN Form 8300 cash reporting, Gusto |
| Manufacturing (planned) | PIRO, Adaptive Jewelry ERP, Acumatica JewelShop, DiamTrade, MatrixGold CAD, Formlabs 3D printing |
| Wholesale (planned) | RapNet and the Rapaport Price List, IDEX Online, Nivoda, VDB (Virtual Diamond Boutique), Polygon, GemFind JewelCloud, Jewelers Board of Trade, PIRO, Adaptive Jewelry ERP, Acumatica JewelShop, DiamTrade, EDI with retail partners (X12 850, 855, 856, 810, 846, 852) |

## Bank and card statements

Clients send statements whichever way suits them: CSV exports, PDF statements, or both (for example CSV for recent activity and PDFs for older years). `CHASE_IMPORT_MODE` takes `manual_csv`, `manual_pdf` or `manual_csv_and_pdf`, and other banks follow the same pattern. Both formats go through the same pipeline. A transaction is keyed by account, date, amount and how many identical ones came before it that day, not by its description, because banks shorten and pad descriptions differently in CSV and PDF. So one that appears in both formats, or in two overlapping exports, is stored once. The connectors are under "Bank and credit card statements" and "Chase" in [Built connectors](#built-connectors).

Statements are customer data. They never go in a git repo, including private ones.

## Testing the integrations

Every system we connect to changes over time, so each connector is tested at four levels as it is built. The unit and contract levels use the connector test kit below, the docs watch runs daily and the sandbox run nightly (see below):

| Level | What it checks | When it runs |
| --- | --- | --- |
| Unit | Normalizers turn recorded and synthetic payloads into valid events | Every push |
| Contract | Recorded responses from each vendor still match what the connector expects (fields, types, pagination, webhook signatures) | Every push |
| Live sandbox | Each connector runs a historical import and an incremental sync against the vendor's own sandbox, and a test webhook is delivered | Nightly |
| Docs watch | Each vendor's API changelog and version list is checked for changes, deprecations and new versions | Daily |

A failure at the live or docs level opens an issue naming the integration, what changed and the evidence. Sandbox credentials are test-only and live in the CI secret store, never in the repo. Synthetic fixtures contain no real customer data.

### The connector test kit

`@karatos/connector-testkit` (in `packages/testkit`) is what every connector's tests use. A sample connector in `packages/testkit/test` uses every helper.

| Helper | What it gives a connector test |
| --- | --- |
| `fixtureBuilder`, `synthetic` | Numbered synthetic records with reserved test emails (`.test`), fictional 555-01xx phone numbers, test SKUs and fixed timestamps |
| `assertSynthetic` | Fails if a fixture holds a real-looking email, phone number or card number, and names where |
| `replayFetch`, `loadRecordings` | A `fetch` that answers from recorded vendor responses, in order, so contract tests run without the network. `unused()` catches requests the connector stopped making |
| `scrubRecording`, `assertScrubbed` | Recordings never hold request headers; tokens in URLs and cookie or auth headers in responses are redacted, and a recording that still holds one won't load |
| `checkConnectorSync` | Runs the connector through a full import, a replay (everything must count as a duplicate), a crash after the first batch plus resume from the checkpoint, and a retried source outage. Every broken scenario is listed in one error |
| `hmacSha256`, `timestampedSignature`, `tamper` | Signed webhook deliveries, and tampered ones, to test signature checks |
| `assertWritesRefused` | Runs every write the connector declares through a read-only `WriteGate` and checks each is refused and audited |
| `docMockFetch`, `checkDocMock` | A `fetch` built from a vendor's published docs, for systems we can't reach yet (below) |

### Mocks built from vendor docs

For paid and partner systems there's nothing to record yet, so the connector is written against a mock built from the vendor's published API docs and verified live once access arrives. Each mock (`packages/testkit/src/mocks/`) says:

- the doc pages it was built from, the day they were read and the API version, so the vendor docs watch checks those pages daily and a change flags the mock as possibly stale;
- the auth the docs describe, answering 401 without it like the real API;
- its `assumptions`: anything the docs leave out that the mock had to guess, such as a default filter or a unit. Each one is checked on the first live run, then fixed or removed.

A request for a path or method the docs don't list throws `UndocumentedRequestError`, so a connector can't come to depend on behavior nobody has seen documented. Data in mocks is synthetic. The mocks cover:

<!-- registry:mocks:start -->
<!-- Generated from the mock modules in packages/testkit/src/mocks/ by npm run registry:write. Edit those, not this block. -->

- Affirm's transaction, transaction event, daily settlement and dispute reads
- Authorize.net's Transaction Reporting requests on its JSON API
- Clover's REST API v3 read endpoints with its v2 OAuth token refresh, including its 90-day cap on orders, payments and refunds
- Typeform's Create API (a form's definition) and Responses API
- Gmail's message, label and history reads with Google's token refresh (API v1)
- Google Drive (files and changes, v3), Sheets (`values:batchGet`, v4) and Calendar (`events.list` with sync tokens, v3) with Google's token refresh, enforcing each API's documented scopes so `drive.metadata.readonly` can't read Sheets values
- HubSpot's CRM search, archived list, batch association and token info endpoints (date version 2026-09)
- monday.com's GraphQL API: boards, items, activity logs and updates
- Plaid's accounts, transactions sync, Item and webhook verification key endpoints (API version 2020-09-14), with webhooks signed the way Plaid signs them
- QuickBooks Online's query and change data capture endpoints with Intuit's token refresh (minor version 75)
- Slack's auth.test, conversations.list, conversations.history and conversations.replies, with both rate-limit regimes (Web API)
- Stuller's invoice and metal market rate endpoints (API v2)
- Xero's Accounting API endpoints with its token refresh

Where a vendor has a free sandbox (Affirm, Authorize.net, Clover, Custom forms, Gmail, Google Workspace and Drive, HubSpot, Monday.com, Plaid, QuickBooks Online, Slack and Xero so far), its mock is a stand-in until a developer account is set up for the nightly run.

<!-- registry:mocks:end -->

### Vendor docs watch

Every integration in the catalog lists its vendor's public API changelog (`changelog` in `packages/core/src/integrations.ts`), or null when the vendor publishes none. The **Vendor docs watch** workflow runs daily:

- It fetches each changelog and compares its readable text with the last run's copy. Scripts, styles and markup are ignored, so a site rebuild isn't a change.
- A change opens one issue, labeled `vendor-docs`, with the removed and added lines as evidence and a short to-do list. If that vendor's issue is still open, a later change is added as a comment instead of a new issue.
- A changelog that answers 404 or 410 opens one "changelog moved" issue so the URL gets fixed. Other failures are listed in the run summary and retried the next day.
- The first run, or a changed URL, only records a baseline.
- It also checks every page a doc-derived mock was built from (`docMockVendorDocsTargets(allDocMocks())`). Each page gets its own snapshot and issue, keyed `integration:page`. A change opens an issue saying which mock may be stale and the day it last matched. A page that answers 404 or 410 opens a "docs page moved" issue.

Run it locally with `npm run build -w @karatos/core -w @karatos/connector-testkit && npm run docs:watch -- --dry-run`, which prints what it would file.

### Nightly sandbox run

The **Nightly sandbox run** workflow runs every built connector against its vendor's own sandbox, into a throwaway in-memory store:

1. **Historical import**, capped at 20 batches. It fails if any record fails validation (the vendor's payloads changed) or if fewer records arrive than the seeded sandbox holds.
2. **Incremental sync** from where the import stopped.
3. **Test webhook**, for vendors that can send one: the check asks the sandbox for a delivery, and the connector must turn it into valid events.

A failure opens one issue, labeled `sandbox-run`, naming the connector and the step. The issue is closed automatically once the connector passes again, and a later failure opens a new one. A connector whose sandbox credentials aren't set is skipped and listed, never failed. The run summary also lists the sandbox-testable systems that aren't built yet.

Each connector registers its check in its own file, `scripts/sandbox-checks/<id>.ts`, and `npm run registry:write` lists it and passes its credentials to the job. Sandbox credentials are test-only, named `SANDBOX_<INTEGRATION>_<WHAT>`, stored as GitHub Actions secrets and passed to the job in `.github/workflows/sandbox-run.yml`; a test fails if a check's credential isn't passed or isn't named that way. They are never a client's credentials. Run it locally with `npm run build -w @karatos/core && npm run sandbox:run -- --dry-run`.

## The connector contract

Every connector implements `Connector` from `@karatos/core`:

- `historicalImport(context)` and `incrementalSync(context)` yield batches of raw records, each with a cursor.
- `handleWebhook(body)`, where the source supports webhooks, turns one delivery into raw records. Verify the signature first.

`runSync` does the rest, so every connector gets the same guarantees:

- The checkpoint advances only after a whole batch is stored, so a crash resumes from the last good batch.
- Source errors are retried with backoff by restarting from the checkpoint. Brain A's own errors are not retried.
- Invalid records are dead-lettered and counted, and never stop the sync.
- Replays are counted as duplicates and stored once.
- Every record is stamped with the instance's organization and the connector's source.

## Syncing on a schedule

An instance syncs each connector it has turned on, on its own. List the connectors in `ENABLED_INTEGRATIONS` (catalog ids, e.g. `shopify,stripe,inventory_pos,bank_statements`) and give each one its settings below. On start the instance logs one line for every listed integration it can't sync, naming the missing settings but never their values, e.g. `sync stripe skipped: missing STRIPE_SECRET_KEY`.

- The first round starts when the instance does. The next one starts `SYNC_INTERVAL_MINUTES` after the last one finished (default 60, allowed 5 to 1440), so rounds never overlap.
- Connectors run one at a time. One failing, for a bad key, an unreadable profile or a vendor outage, is logged and the others still run.
- Each connector runs its historical import until it has finished once, then syncs incrementally from its own checkpoint. A failed import resumes on the next round rather than being skipped.
- Each connector is rebuilt every round, so a new file in an import folder, a changed profile or a rotated key is picked up without a restart.
- Each round logs one line per connector: how many records were new, duplicates or dead-lettered.
- Syncing only reads. Writes still go through `WriteGate` and `ENABLED_WRITES`.

## Built connectors

Connectors live in `@karatos/connectors` (`packages/connectors`). Each one is read-only, and the token or app it uses should hold read scopes only.

Each connector keeps everything about itself in its own files, and every list that names all of them is generated by `npm run registry:write`; [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-connector) lists the files. When a connector is finished, do all of these in the same PR:

1. Add `packages/core/src/catalog/<id>.ts` with `status: "built"` and its `capabilities`: what the business gets once it is connected, one plain sentence each. A test in `@karatos/connectors` fails if a connector there isn't marked built with capabilities.
2. Check the website. It shows "Connector built" and the capabilities on the system's card, and names the connector in the hero, straight from the catalog, so no site edit is needed.
3. Add `docs/integrations/<id>.md` on what the connector reads and how to configure it. The sections below are generated from those files.
4. Run `npm run registry:write` and commit what it writes.
5. Write the customer setup guide in the private commercial runbook (`help/<id>.md`). Setup guides are not published yet.

<!-- registry:connector-docs:start -->
<!-- Generated from docs/integrations/<id>.md by npm run registry:write. Edit those, not this block. -->

### Affirm

Reads Affirm's Merchant APIs on its US hosts (`https://api.affirm.com`, or `sandbox.affirm.com` for a sandbox account) with GET requests only, authenticated with HTTP Basic: the public API key as the user, the private API key as the password. The same key pair can capture, refund and void loans, and Affirm can't limit a key to reading, so read-only is enforced in the client: it sends five reads only (`list_transactions`, `read_transaction`, `list_transaction_events`, `list_settlement_event_summaries` and Disputes API v3's `list_disputes`), each with only the query parameters it checked itself, and throws before sending anything else. It never sends the transaction list's `query` (which searches shopper emails, names and phones) or expands the checkout. The writes it may do later (capture, refund and void a transaction) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `AFFIRM_PUBLIC_API_KEY`, `AFFIRM_PRIVATE_API_KEY` | The merchant's key pair, from API keys in the Affirm merchant portal; sandbox and production each have their own |
| `AFFIRM_MERCHANT_ID` | The Affirm Merchant ID, which the settlement reads require |
| `AFFIRM_ENVIRONMENT` | `sandbox` or `production`, with no default, so a setting meant for one can't reach the other |
| `AFFIRM_WEBHOOK_SECRET` | Optional. The secret Affirm signs webhooks with, for when webhooks are turned on |

Canadian accounts are on Affirm's global hosts (`api.global.affirm.com`), which also need a `country-code` header; the connector doesn't read them yet.

**What it reads.** Affirm's transaction list filters by creation time, so the historical import lists the transactions created in the last five years, newest first, 100 per page, each with its current status. It then lists the refund events over the same span, every dispute (100 per page), and the daily settlement summaries 1000 per page. Incremental syncs list the transactions created since the previous pass started, less an hour so nothing saved mid-pass is missed, then every transaction event since then. A capture, void, expired authorization or refund changes a transaction created earlier, so each transaction such an event names is read again for its new status. Disputes are read whole on every pass, since a dispute's status moves without a date to filter on and a store has few. With no checkpoint the first pass looks back 48 hours. Each list stops when Affirm says there is no next page; a next page the connector can't read, or one that points back at the same page, stops the sync with an error rather than skip or loop. Affirm publishes no rate limit; calls go one at a time, and a 429 or 503 is retried (honouring `Retry-After` up to a minute, three tries) before the sync stops and resumes from its checkpoint next run.

**Events.** The same neutral types as Stripe: `payment.charge_updated` for each financed order (Affirm's status alongside succeeded, pending or failed, whether it was captured, voided or disputed, the amount refunded, and the store's own order number so it can be matched to the sale), `payment.refund_updated` for each refund, linked to the transaction, `payment.dispute_updated` for each dispute, and `payout.updated` for each day's settlement, with sales, refunds and Affirm's fees behind the amount deposited and the deposit ID the bank statement shows. Affirm already sends whole cents, with the currency alongside. Each transaction is keyed by its id, status and amount refunded, so each step is stored once and a replay is a duplicate. Affirm's responses carry a signed token that may hold encrypted personal data, and its events can carry the shopper's shipping name, email, phone and address; none of that is kept, nor the bank account's last four digits.

**Webhooks.** Affirm sets webhooks up itself, on request through its support widget; the events its docs describe are about checkouts and prequalification, and a failed delivery isn't resent. `verifyAffirmWebhook` checks the `Affirm-Signature` header (the docs also call it `X-Affirm-Signature`): `t=<timestamp>` and one or more `v0=<hex>` signatures, each the HMAC-SHA512 of `<timestamp>.<raw body>` keyed with the signing secret, compared in constant time. Only `v0` counts, so a downgrade is refused, and a timestamp more than five minutes off is refused as stale, so an old delivery can't be replayed. A delivery is a prompt to sync, never data; the instance doesn't take webhooks yet, and the scheduled sync picks every change up. The docs don't say whether the timestamp is in seconds; the check assumes Unix seconds, as Stripe's scheme does, until a live delivery shows otherwise.

**Testing.** The tests run against a mock built from Affirm's docs (`packages/testkit/src/mocks/affirm.ts`), which answers the sandbox or production host only, checks the key pair, refuses parameters the docs don't list, pages each list as its page describes, and throws for any POST. Its assumptions (the list order, `next_page`'s shape, date formats the docs leave out) are listed in the mock and checked on the first sandbox run. For the nightly run, take the sandbox key pair from sandbox.affirm.com/dashboard/apikeys (an Affirm merchant account comes with sandbox access) and the Merchant ID from Affirm support, and add them as the `SANDBOX_AFFIRM_PUBLIC_API_KEY`, `SANDBOX_AFFIRM_PRIVATE_API_KEY` and `SANDBOX_AFFIRM_MERCHANT_ID` GitHub Actions secrets.

### Authorize.net

Reads Authorize.net's Transaction Reporting through its JSON API (`https://api.authorize.net/xml/v1/request.api`, or `apitest.authorize.net` for a sandbox account). Every call is a POST to that one endpoint naming its request, and the API Login ID and Transaction Key that read reports can also charge, refund and void: Authorize.net can't limit a key to reading. So read-only is enforced in the client: it sends five requests only (`getMerchantDetailsRequest`, `getSettledBatchListRequest`, `getTransactionListRequest`, `getUnsettledTransactionListRequest` and `getTransactionDetailsRequest`), with only the fields it checked itself, and throws before sending anything else. The writes it may do later (refund and void a transaction) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `AUTHORIZE_NET_API_LOGIN_ID`, `AUTHORIZE_NET_TRANSACTION_KEY` | The merchant's API credentials, from Account > Settings > Security Settings > API Credentials and Keys in the Merchant Interface |
| `AUTHORIZE_NET_ENVIRONMENT` | `sandbox` or `production`, with no default, so a setting meant for one can't reach the other |
| `AUTHORIZE_NET_SIGNATURE_KEY` | Optional. The Signature Key, for when webhooks are turned on |

The Transaction Details API must be turned on for the account (Account > Settings > Security Settings); without it Authorize.net answers `E00011`, and the error says so.

**The API's quirks.** The JSON API is a translation of the XML one, so fields must go in the schema's order, and the client writes them that way. Errors come back as HTTP 200 with `resultCode: "Error"` and a code such as `E00007` (bad credentials). Responses start with a byte order mark, which Authorize.net keeps so as not to break existing integrations; fetch drops it while decoding, and the client strips it again in case another fetch doesn't. Transactions carry no currency, so it comes from the account's merchant details. Authorize.net publishes no rate limit; calls go one at a time, and a 429 or 503 is retried (honouring `Retry-After` up to a minute, three tries) before the sync stops and resumes from its checkpoint next run.

**What it reads.** The historical import walks the settled batch list from five years back in 31-day windows, the most one list may cover, then lists each batch's transactions 1000 per page, ordered by id, and finally every transaction not yet settled. Incremental syncs walk the windows from where the previous pass started, less an hour so a batch that settles mid-pass is never missed, and read the unsettled transactions again, so a capture or void shows up before it settles. With no checkpoint the first pass looks back 48 hours. For refunds, chargebacks and returned eChecks only, the transaction's details are read for the transaction they refer to (`refTransId`); nothing else from the details is kept.

**Events.** The same neutral types as Stripe: `payment.charge_updated` (with Authorize.net's own status alongside succeeded, pending or failed, whether it was captured or voided, the card brand and the channel), `payment.refund_updated` and `payment.dispute_updated` for chargebacks and returned eChecks, each linked to the charge, and `payout.updated` for each settlement batch, with charges less refunds and the counts behind them. Amounts become whole cents with the currency alongside. Each transaction is keyed by its id and status, so each step from authorized to settled is stored once and a replay is a duplicate. Like Stripe, a card is kept as its brand only: no masked card or bank account numbers, names, emails, phone numbers, addresses, customer IP addresses, invoice numbers or descriptions.

**Webhooks.** `verifyAuthorizeNetWebhook` checks `X-ANET-Signature`, which is `sha512=` and the hex HMAC-SHA512 of the raw body keyed with the Signature Key (as text), compared in constant time. Anything but a match must be answered 401. `authorizeNetWebhookChange` names the transaction a payment event is about. A delivery carries only part of the transaction, so it is a prompt to sync, not data. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** The tests run against a mock built from Authorize.net's docs (`packages/testkit/src/mocks/authorize_net.ts`), which answers the sandbox or production host only, checks the credentials and the field order, enforces the 31-day range and paging, sends the byte order mark, and throws for any request outside reporting. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, create a free sandbox account at developer.authorize.net, turn on the Transaction Details API, and add its API Login ID and Transaction Key as the `SANDBOX_AUTHORIZE_NET_API_LOGIN_ID` and `SANDBOX_AUTHORIZE_NET_TRANSACTION_KEY` GitHub Actions secrets.

### Bank and credit card statements

Reads bank and credit card activity exported as CSV, and PDF statements, one folder per account. Both go through the same keys, so a transaction in both formats is stored once.

| Setting | What it is |
| --- | --- |
| `BANK_STATEMENTS_IMPORT_DIR` | The folder of exports, outside any git repo. Inside it, one subfolder per account named for its type and last four digits: `checking-1234`, `savings-2345`, `card-5678`. A name containing `card` or `credit` is read as a credit card. Other folders are skipped |
| `BANK_STATEMENTS_PROFILES` | Optional. A built-in profile's name (`generic`, `chase_checking`, `chase_card`), or the path to a JSON file in the client's private instance repo mapping account folders to parsing profiles or built-in names, with `"*"` for the rest |

**Parsing profiles.** A profile names the date and description columns, either one signed amount column or separate debit and credit columns, and optionally balance and check number. It also gives the delimiter, the date order, the bank's UTC offset, how the amount column is signed (`money_in_positive`, or `money_out_positive` for card exports that show purchases as positive), and the client's own category rules: regular expressions tested against the description, in order. The generic profile reads Date (or Posting Date, Transaction Date, Posted Date), Description (or Memo, Details, Payee), Amount or Debit and Credit (or Withdrawals and Deposits), Balance and Check Number. Rules naming a client's payees belong in their instance repo.

**What it reads.** Each CSV in an account's folder, in name order, accounts in name order. Title lines above the header are skipped: the header is the first line with every required column. Rows with no date or no amount (opening balances, totals) are skipped, and rows older than six years too. The checkpoint and resume work as for the POS connector: a file is read again only when its content changes.

**PDF statements.** Each PDF in an account's folder is read as text, line by line, with table columns two or more spaces apart. A profile's `pdf` layout says how to read it; the generic layout reads the common one:

- **Transaction lines:** a date (`01/05`, or with the year), the description, then the amount, and sometimes a running balance.
- **Section headings** set how amounts below them are signed, since statements list deposits and withdrawals under their own headings without minus signs. Deposits, additions, credits, and payments and credits read as money in. Withdrawals, debits, checks, fees, purchases, cash advances and interest charged read as money out. Account summaries and daily balance tables are skipped. Outside those sections, an amount is read as written; `(25.00)`, `-25.00`, `25.00-` and `−25.00` are all money out.
- **Years:** a date without a year takes the year of the statement's closing date (found from "through 01/15/2026", "Closing Date 01/12/2026" and the like), or the year before when it falls after the closing day, so December lines on a January statement land in December.
- **Not transactions:** opening, closing, beginning, ending and new balance lines, and totals.

A dated line with money on it, under a transactions heading, that the layout can't read is dead-lettered with its page and line kept (`checking-1234/jan.pdf:p2:5`), never dropped. A PDF with no transactions and no headings the layout knows stops the sync with the file named, since it needs a profile. A client's own layout goes under `pdf` in their profile: `transaction`, a regular expression with named groups `date`, `description`, and `amount` (or `debit` and `credit`), optionally `balance`; `period`, with a group named `end`; `sections`, each a pattern and `money_in`, `money_out`, `signed` or `skip`; and `ignore` patterns.

PDFs come from outside, so the reader (pdf.js) renders no forms and loads no fonts, a file over 20 MB or 300 pages is rejected, a text line over 500 characters (longer than any statement prints) is never matched against the layout's patterns but dead-lettered if it starts with a date, and a password-protected statement stops with a message asking for one without a password. The instance image leaves out pdf.js's optional native canvas package, which only drawing needs.

**Events.** Each row becomes `bank.transaction_imported` in the finance department's shape, with money into the account positive. The key is `bank:<account>:<date>:<amount cents>:<n>`, where `n` counts identical transactions earlier that day in the same file, so two $20 payments on one day are both kept and an overlapping export stores neither twice. The payload adds `accountKind`, `balanceCents` and `checkNumber` when present, and `sourceRow` (`checking-1234/jan.csv:12`). A date or amount that can't be read is dead-lettered with the row kept.

**Categories.** After the profile's own rules:

| Category | Built-in rule |
| --- | --- |
| `card_settlement` | Money into a bank account from a processor: Stripe, Square, Shopify, PayPal, Clover, Heartland, Worldpay, Authorize.net, or "bankcard", "merchant" or "settlement" |
| `other` | Transfers between the business's own accounts and card payments, in either direction |
| `payroll` | Money out to Gusto, ADP, Paychex, Rippling, or described as payroll or wages |
| `fee` | Fees, service and maintenance charges, overdrafts, NSF, interest and finance charges |
| `other` | Mobile, remote and check deposits, ACH, wires, Zelle, refunds and interest paid in |
| `cash_deposit` | Other money into a bank account described as cash, a branch, teller, night or counter deposit, or starting "DEPOSIT". A client who deposits checks at the branch needs a profile rule |
| `vendor_payment` | Money out by check, ACH, wire, bill pay, Zelle, debit card or POS purchase, and every other charge on a credit card |

Anything else is `other`. The finance department compares `cash_deposit` transactions with cash sales.

**Testing.** Synthetic statements only: a title block above the header, debit and credit columns, opening balance and total rows, identical same-day payments, an overlapping export in another layout, and unreadable rows. PDF fixtures are written by the test itself with `syntheticPdf` from the connector test kit: a two-page checking statement spanning December and January, a card statement, a custom debit-and-credit layout, and a PDF that matches no layout. Statements are customer data and never go in a repo.

### Chase

Chase business checking, savings and credit cards, from the CSV activity downloads in Chase's online banking, the monthly PDF statements, or both. It is the bank and credit card statements connector with Chase's own profiles built in, synced under its own source, `chase`, so no profile file is needed.

| Setting | What it is |
| --- | --- |
| `CHASE_IMPORT_MODE` | `manual_csv`, `manual_pdf` or `manual_csv_and_pdf`: which files in the folders to read. Anything else stops the sync with an error naming the three choices |
| `CHASE_MANUAL_IMPORT_DIR` | The folder of downloads, outside any git repo, with one subfolder per account like `checking-1234`, `savings-2345` or `card-5678`. Card and credit folders are read with the card profile, and the rest with the checking profile |

**What the profiles know.** For checking and savings, the CSV columns are Details, Posting Date, Description, Amount, Type, Balance and Check or Slip #, and the trailing comma Chase puts on every row is ignored. The PDF period line reads "December 16, 2025 through January 15, 2026", and lines under CHECKS PAID start with the check number, sometimes with a `^` or `*` mark, then the date paid. Those become `CHECK 1001` with the check number kept. For cards, the CSV columns are Transaction Date, Description and Amount, where purchases are negative and payments positive. The PDF closing date comes from "Opening/Closing Date 12/16/25 - 01/15/26", and charges sit under PURCHASE. Both profiles are also available to the generic connector by name in `BANK_STATEMENTS_PROFILES`.

The profiles were written from Chase's published download format and statement layout. Before sign-off, check them against one of the client's own statements and confirm the event count matches the statement's transaction count.

**Testing.** `packages/connectors/test/chase.test.ts` writes a synthetic two-page checking statement, a card statement and matching CSV downloads. It checks that each format reads the same transactions with the same keys, that each import mode reads only its own files, and that account folders get the right profile. No real statement goes in a repo.

### Clover

Reads the Clover REST API (v3) for one merchant. Read-only rests on the client: Clover sets permissions on the app and the merchant approves them on install, but documents no way to read back which permissions a token holds, so the connector can't check for a Write permission the way it can check Xero's scopes. Instead the client sends GET requests to these paths only, checked before each request: the merchant itself, `orders`, `payments`, `refunds`, `items` (and one item by ID, for the SKU of a sold item it hasn't seen), `item_stocks` and `customers` under `/v3/merchants/{mId}`, on one of Clover's hosts (`api.clover.com`, `api.eu.clover.com`, `api.la.clover.com`, or the sandbox `apisandbox.dev.clover.com`). Its only POST is the token refresh to `/oauth/v2/refresh` on the same host. The writes it may do later (adjust stock, update items) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `CLOVER_MERCHANT_ID` | The merchant's 13-character ID. Every run first reads the merchant and stops if the token answers for another |
| `CLOVER_REGION` | `north_america`, `europe`, `latin_america` or `sandbox`: which host to call |
| `CLOVER_APP_ID`, `CLOVER_APP_SECRET`, `CLOVER_REFRESH_TOKEN` | The KaratOS app's ID (Clover's OAuth client_id), its secret (which seals the stored refresh token) and the refresh token from connecting the merchant |
| `CLOVER_API_TOKEN` | Instead of the three above: a merchant-specific API token from the merchant's dashboard, which doesn't expire |
| `CUSTOMER_REF_KEY` | The instance's key for customer references (below). Generated by `npm run secrets:setup` |
| `CLOVER_WEBHOOK_AUTH_CODE` | Optional. The app's webhook auth code, for when webhooks are turned on |

**Permissions.** Give the app (or the API token) only Read merchant, Read orders, Read payments, Read inventory and Read customers. A merchant who installed the app before its permissions changed must reinstall it.

**Tokens.** Clover's v2 OAuth tokens expire; Clover gives each access token's expiry and says not to assume a lifetime. Access tokens are refreshed two minutes early, one refresh at a time. Each refresh returns a new refresh token and retires the old one at once, so each new one is saved first, sealed in the instance's database the same way as QuickBooks' (AES-256-GCM under a key derived from `CLOVER_APP_SECRET`, bound to the organization). A 401 from the refresh means the merchant needs reconnecting.

**What it reads.** Items (all of them on the import, then those modified since the last pass), item stocks and customers (all of them every pass, since Clover can't filter either by modified time), then orders with their lines, payments and refunds, payments with their tender and card details, and refunds. Orders and payments are read by `modifiedTime`, refunds by `createdTime`, five years back on the import and from the previous pass's start (less five minutes) after that; with no checkpoint the first incremental pass looks back 48 hours. Clover returns at most 90 days of orders, payments and refunds per request and quietly trims a longer range, so these are read 89 days at a time. Each page is 1000 records, Clover's limit, oldest first. The next page starts from the last record's time rather than a growing offset, so a record changed mid-pass can't shift the pages and make one be missed.

**Rate limits.** Clover allows 16 requests a second and 5 at once per token. Requests go one at a time; a 429 waits Clover's `retry-after` (at most a minute), or one second doubling, five times. Then the sync stops with its checkpoint, and the next run resumes at the page it stopped on.

**Events.** The same types and shapes as the Shopify, POS and Stripe connectors, so a business on more than one is read the same way: `order.updated` (Shopify's shape) for each version of an order; `sale.completed` for a paid order, with its lines, discounts and tenders, and `sale.returned` for each refund of its lines (sales department); `payment.charge_updated` and `payment.refund_updated` (Stripe's shapes) for payments and refunds; `product.updated` (Shopify's shape, one variant per item) for items; `inventory.counted` (the POS connector's shape) for the stock on hand when read, once a day per count; and `customer.profile_updated` for customers. A sold line carries the item's SKU, or `clover-item-<id>` for an item without one, the same on its product and stock. Clover returns at most 100 nested lines, so an order with 100 lines records its state but no sale. A negative (oversold) stock count is kept as read, and the inventory schema dead-letters it with the record kept.

**Privacy.** A customer is kept only as a reference, `clover_customer:` and an HMAC-SHA256 of the merchant and Clover's customer ID keyed with `CUSTOMER_REF_KEY`, with their marketing choice. The same key is used for customer references from custom forms. No names, email addresses, phone numbers or addresses are kept, and the merchant's own name and address are read but not stored. A card payment keeps only its card type and last four digits. Order titles and notes, which staff type freely, are dropped.

**Webhooks.** Clover doesn't sign notifications. `verifyCloverWebhook` compares `X-Clover-Auth` with the app's auth code in constant time; anything else is answered 401. `cloverVerificationCode` reads the one-off code Clover posts when the webhook URL is saved, for the owner to paste into the app's settings. `cloverWebhookChanges` lists this merchant's order, payment, item, item stock and customer changes, dropping notifications more than a day old, and `CloverWebhookDeduper` counts a repeated one once. A notification names what changed without the record, so it is a prompt to sync, not data. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** The tests run against a mock built from Clover's docs (`packages/testkit/src/mocks/clover.ts`), which rotates refresh tokens and refuses the old one, answers 401 without a valid token or for another merchant, trims order, payment and refund ranges to 90 days, enforces Clover's filter fields, paging and expansions, and returns nested records only when expanded. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, create a free Clover developer account, open its test merchant's dashboard, create an API token with only the Read permissions above, and add `SANDBOX_CLOVER_MERCHANT_ID`, `SANDBOX_CLOVER_API_TOKEN` and `SANDBOX_CLOVER_CUSTOMER_REF_KEY` (any 64 hex characters) as GitHub Actions secrets. The API token doesn't rotate, so the run keeps working.

### Custom forms

Appointment requests, repair intake and custom order requests, from two kinds of form. Typeform forms are read through Typeform's API. Any other form tool, or the business's own website form, posts each submission to the instance signed with a shared secret (below). Both go through the same mapping profile and become the same event, so the departments read them the same way.

Submissions hold the most personal data Brain A reads: names, emails, phone numbers, descriptions in the customer's own words, and photos. The connector keeps only what the profile maps to a safe field and drops the rest before anything is stored.

| Setting | What it is |
| --- | --- |
| `CUSTOMER_REF_KEY` | Generated. The key for customer references (below). Never rotate it: a new key stops old and new requests from linking up |
| `TYPEFORM_ACCESS_TOKEN` | A Typeform personal access token with only `forms:read` and `responses:read` |
| `TYPEFORM_FORM_IDS` | The forms to read, by id, separated by commas. The id is the end of the form's link: `u6nXL7` in `…typeform.com/to/u6nXL7` |
| `TYPEFORM_API_HOST` | Optional. `api.typeform.com` (the default), `api.eu.typeform.com`, or `api.typeform.eu` for Typeform's newer EU data center |
| `TYPEFORM_WEBHOOK_SECRET` | Optional. The secret set on the forms' Typeform webhooks, once webhooks are turned on |
| `WEBHOOK_SIGNING_SECRET` | Generated for every instance. The key a website form signs its submissions with |
| `FORMS_MAPPING_PROFILE` | Optional. `generic`, or the path to a form mapping profile JSON in the client's private instance repo |

**Read-only.** The Typeform client sends GET requests for two things only, a form's definition and its responses, with parameters it checks itself. Typeform has no way to look up which scopes a token holds, so unlike Xero the connector can't refuse a token with more than read access; create it with only the two read scopes, and the allowlist keeps the connector from writing either way. No writes are declared, so the write gate has nothing to allow.

**What it reads from Typeform.** The historical import reads each form's completed responses submitted in the last five years. Incremental syncs read what was submitted since the previous pass started, less five minutes so a response saved mid-pass is never missed; with no checkpoint the first pass looks back 48 hours. Typeform answers newest first, 1000 per page, and pages back with `before` (the last response's token) between fixed `since` and `until` times, so pages don't shift while new responses arrive. Partial responses aren't read. Submitted responses can't be edited, so there are no changes to follow. Each form's definition is read once per run for its question titles and to check its region: Typeform answers an empty list from the wrong host, so if the form's responses link names another host the sync stops and says which `TYPEFORM_API_HOST` to set.

**Rate limits.** Typeform allows two requests a second per account across its Create and Responses APIs. Requests are spaced half a second apart; a 429 is waited out (Typeform's `Retry-After` if it sends one, at most a minute, three tries), then the sync stops and the next run resumes from its checkpoint.

**Mapping profiles.** A profile names the question for each safe field by its Typeform ref, id or title, or a website form's field name, matched without regard to case, spacing or punctuation. It can give a whole form one kind (`forms`), rules that tell the kind from the kind question's answer or the form's title (`kinds`), and the business's own values for item types, metals, stones, budget ranges, store locations and time slots (`values`), each a regular expression and the value it means. `parseFormProfile` validates a profile and says which field is wrong. Profiles for one client's forms belong in that client's instance repo, never here.

```json
{
  "id": "client_forms",
  "name": "Client forms",
  "forms": { "u6nXL7": "repair_intake" },
  "kinds": [{ "match": "\\bconsult", "kind": "appointment_request" }],
  "fields": { "metal": ["Metal", "metal_choice"], "storeLocation": "Which store?" },
  "values": { "storeLocation": [{ "match": "\\bdowntown", "value": "downtown" }] }
}
```

The generic profile reads these question names, and the values it knows are matched before anything else:

| Field | Questions named | Kept as |
| --- | --- | --- |
| kind | Request type, How can we help, What can we help with, Service, Kind | `appointment_request`, `repair_intake`, `custom_order_request` or `other`, by keyword (repair, resize, clean; custom, design, engagement ring, quote; appointment, book, consult, visit) or the form's title |
| `requestedDate` | Preferred date, Appointment date, Requested date, Date | A real calendar day, `YYYY-MM-DD` |
| `requestedTime` | Preferred time, Appointment time, Requested time, Time | A clock time (`2:30 pm` becomes `14:30`), or a time slot the form offers |
| `itemType` | Item type, Type of jewelry, Piece, Item | `engagement_ring`, `wedding_band`, `ring`, `necklace`, `pendant`, `bracelet`, `earrings`, `watch`, `brooch` |
| `metal` | Metal, Metal type, Preferred metal | `yellow_gold`, `white_gold`, `rose_gold`, `platinum`, `palladium`, `silver`, `titanium`, `undecided` |
| `stone` | Stone, Gemstone, Center stone, Stone type | `diamond`, `lab_diamond`, `moissanite`, `sapphire`, `ruby`, `emerald`, `pearl`, `none` |
| `budgetAmount` or `budgetRange` | Budget, Budget range, Price range | A number answer as a whole amount, or a range the form offers |
| `preferredContact` | Preferred contact method, How should we contact you, Contact method | `email`, `phone`, `text`, `in_person` or `video` |
| `storeLocation` | Store, Location, Preferred store | Only a store the form offers, or one the client's profile names |
| customer reference | Email, Email address; Phone, Phone number, Mobile | Never kept; see below. Typeform email and phone questions are used when no name matches |

**What it keeps and drops.** A typed answer is kept only when it matches one of the profile's values, and a choice only as the label the form itself offers; a choice's "other" text is the customer's own words and is dropped like any other typed text. The preferred contact channel is always one of the five fixed values. Names, email addresses, phone numbers, street addresses, descriptions, link and payment answers, signatures, Typeform hidden fields, scores, variables and browser details are never kept. Uploaded files are counted (`attachmentCount`) so repairs sees a photo came with a request, but their links are never followed or stored. A safe field that was answered but couldn't be kept is named in `unmappedFields`, never with its value, so the owner can see which questions the profile should cover.

**Customer references.** A submission's email address, or else its phone number, becomes `customerRef`: `form_customer:` and an HMAC-SHA256 of the normalized address or number, keyed with the instance's `CUSTOMER_REF_KEY`. The same person's requests link up across forms and over the years, but the detail itself is never stored, nobody holding the events can test a guessed address without the key, and two instances never share references. `contactRefs` lists both references when a submission gave both. A plain hash would not do: email addresses are easy to guess and hash.

**Events.** Each submission becomes one `forms.submission_received` event, keyed by provider, form and response id (`custom_forms:typeform:<form>:<response>` or `custom_forms:webhook:<form>:<id>`), so a Typeform response read by the sync and delivered by webhook is stored once and a replay is a duplicate. A request isn't yet a repair ticket or a custom order, which need a price, a promised date and a description, so it has its own type rather than `repair.received` or `custom_order.created`. A submission without a readable time is dead-lettered, not given one.

**Typeform webhooks.** Set a webhook on each form with `TYPEFORM_WEBHOOK_SECRET` as its secret. `verifyTypeformWebhook` checks `Typeform-Signature`, `sha256=` and the base64 HMAC-SHA256 of the raw body; anything else is refused. Typeform signs no timestamp, so a replayed delivery can't be told from the first, but it carries a response already stored and counts as a duplicate. The connector's `handleWebhook` turns a verified `form_response` delivery for a listed form into the same event the sync makes. The instance doesn't take webhooks yet; the scheduled sync picks every response up.

**Signing submissions from a website form.** Any form tool or website that can sign its POST can send submissions. The signing must happen on the website's server: `WEBHOOK_SIGNING_SECRET` must never be in a web page's own code, where anyone could read it. Send the submission as JSON:

```json
{
  "id": "sub_20261022_0001",
  "form": "repair-intake",
  "title": "Repair intake",
  "submittedAt": "2026-10-22T15:04:05Z",
  "kind": "repair_intake",
  "fields": { "item type": "Ring", "metal": "White gold", "preferred date": "2026-11-03", "email": "customer@example.test" }
}
```

`id` is the website's own id for the submission, unique within the form, and `form` names the form; both are letters, digits, `-` and `_`. `title` and `kind` (one of the four kinds) are optional. Field values are text, numbers, true or false, or lists of text, named as the profile names them. Every value is treated as typed by the customer, so only values matching the profile are kept.

Sign it with two headers:

1. `X-KaratOS-Timestamp`: the current Unix time in seconds.
2. `X-KaratOS-Signature`: `v1=` and the hex HMAC-SHA256, keyed with `WEBHOOK_SIGNING_SECRET`, of the timestamp, a full stop and the exact body bytes sent.

```js
import { createHmac } from "node:crypto";

const body = JSON.stringify(submission);
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = createHmac("sha256", process.env.WEBHOOK_SIGNING_SECRET).update(`${timestamp}.${body}`).digest("hex");
await fetch(instanceFormsUrl, {
  method: "POST",
  headers: { "content-type": "application/json", "x-karatos-timestamp": timestamp, "x-karatos-signature": `v1=${signature}` },
  body,
});
```

`verifyFormWebhook` checks the signature over the raw body before it is parsed, and refuses a timestamp more than five minutes from the instance's clock either way, so a captured submission can't be replayed later and the timestamp can't be changed without breaking the signature. Keep the server's clock synced. `signFormWebhook` makes the same headers for a sender written in Node, and `formWebhookEvents` turns a verified body into the event.

**Testing.** Until a Typeform test account is set up, the tests run against a mock built from Typeform's docs (`packages/testkit/src/mocks/typeform.ts`), which answers a form's definition and its responses only, pages with `before` newest first, filters by `since` and `until`, refuses a page size over 1000, answers 401 without the token, and names the responses host in the form's links. Its assumptions are listed in the mock and checked on the first sandbox run. Fixtures are synthetic and carry the personal data a real submission would, so the tests can check none of it is kept. For the nightly run, create a free Typeform account, build a test form and fill it in with made-up answers, create a personal token with `forms:read` and `responses:read`, and add `SANDBOX_CUSTOM_FORMS_TYPEFORM_TOKEN` and `SANDBOX_CUSTOM_FORMS_TYPEFORM_FORM_ID` as GitHub Actions secrets.

### Gmail

Reads one mailbox's message metadata, threads and labels through the Gmail API, for clienteling (who the store is talking to and how recently), buying (which vendors write, and how often) and custom orders (the threads around a commission). It never reads a message body, an attachment or a subject.

**Scope.** The mailbox is connected with `https://www.googleapis.com/auth/gmail.metadata` only: headers and labels, without bodies or attachments, and no way to change anything. With that scope Gmail rejects a search query (`q`) and the `full` and `raw` formats, so the limits are Google's as well as the connector's. `gmail.readonly` isn't needed and would expose bodies; `gmail.labels` can create and delete labels, and `gmail.modify`, `gmail.send`, `gmail.compose` and `https://mail.google.com/` can change or send mail. The client checks the `scope` field of every token Google issues and stops if it holds anything beyond `gmail.metadata` and the sign-in scopes (`openid`, `email`), or doesn't say. Read-only is also enforced in code: the client sends four GETs (`messages.list`, `messages.get` with `format=metadata` and the headers `From`, `To` and `Cc` only, `labels.list`, `history.list`), checks every parameter, and throws on anything else before it is sent. Its one POST is the token refresh to `oauth2.googleapis.com`. The writes it may do later (`draft_reply`, `apply_label`) are declared and stay behind the write gate.

**Google verification.** `gmail.metadata` is a restricted scope. An app whose consent screen is set to **Internal**, used only by accounts in the business's own Google Workspace organization, doesn't need Google's verification. Any other app (a consent screen set to **External**, for instance for a personal gmail.com mailbox) needs Google's OAuth verification for restricted scopes before production use, and Google asks for a security assessment when restricted-scope data is kept on servers, which a KaratOS instance does. Until then, an External app in **Testing** status is limited to 100 listed test users, and **its refresh tokens expire after 7 days**, so the sync stops with `invalid_grant` a week after each connection.

| Setting | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The instance's Google OAuth client (Web application), shared with Google Drive |
| `GMAIL_REFRESH_TOKEN` | The refresh token from connecting the mailbox with `gmail.metadata` and `access_type=offline` |
| `CORRESPONDENT_HASH_KEY` | The instance's key for correspondent references. `npm run secrets:setup` generates it; don't rotate it, or history stops lining up |
| `GMAIL_USER` | Optional. `me` (the default) or the mailbox's address. One mailbox per instance |
| `GMAIL_LABEL_NAMES` | Optional. `keep` (the default) or `drop`, for a mailbox whose labels are named after customers |

**Tokens.** Access tokens last an hour and are refreshed two minutes early, one refresh at a time. Google doesn't rotate refresh tokens, so `GMAIL_REFRESH_TOKEN` keeps working until the owner revokes access, changes their password, leaves it unused for six months, or (in Testing) seven days pass; an account holds at most 100 live refresh tokens per client, and connecting a 101st silently ends the oldest. The token store is the same sealed one QuickBooks uses, so if Google ever does return a new refresh token it is saved, encrypted, in the instance's database. An `invalid_grant` error means the mailbox needs reconnecting.

**What it reads.** The historical import reads the labels, then every message newest first, 500 to a page, with each one's metadata, and stops after the first page in which every message is more than five years old. With the metadata scope Gmail takes no search query, so there is no date filter: the cutoff is applied to each message's `internalDate`. Incremental syncs read the labels again and then the mailbox history from the last history id (messages added and deleted, labels added and removed), and read each changed message again so its event carries its whole label set. Gmail keeps history for about a week, sometimes less; when it answers 404 the pass lists messages back to where the previous pass started and takes a fresh history id. A label change on an older message during such a gap is picked up the next time that message changes. Drafts and spam are skipped.

**Quota.** Gmail allows 6,000 quota units a minute per mailbox, and a message read costs 20, so the client paces itself to 5,000 a minute: about 250 messages a minute, or several hours for a busy mailbox's first import, which resumes from its checkpoint if interrupted. 429s and `rateLimitExceeded` or `userRateLimitExceeded` 403s are retried with backoff, honouring `Retry-After`; a `dailyLimitExceeded` 403 stops the sync until the next round.

**Events.** `communication.message_logged` keeps the message and thread ids, `internalDate`, direction (`sent` when the message has the `SENT` label, otherwise `received`), the sender and the To and Cc recipients as correspondent references (at most 50 per header, with the full count), and the label ids. `communication.label_updated` keeps each label's id, whether it is a system or user label, and its name. `communication.message_deleted` records a deletion. A message is keyed by its id and a hash of its label set, so a label change is stored as a new version and a replay is a duplicate.

**Personal data.** Kept: ids, times, direction, counts, label ids and names. Never kept: bodies, attachments and file names (the scope can't see them), subjects (never requested, since they often carry a customer's name, a ring size or an order number), the snippet of text Gmail sends with every message, display names, and every raw address. Each address becomes `correspondent:<hash>`, an HMAC-SHA256 under `CORRESPONDENT_HASH_KEY`, so the same person is the same reference across messages but the reference can't be reversed or matched against another instance's. The address's domain is kept beside it only for business domains, so a vendor's mail is attributable; consumer services (gmail.com, outlook.com, yahoo.com, icloud.com and the like) keep no domain. A sole trader on their own domain still keeps that domain. User label names are kept unless they contain an @ or four digits in a row; set `GMAIL_LABEL_NAMES=drop` if the mailbox names labels after customers.

**Push.** Gmail can push changes through Cloud Pub/Sub (`users.watch`), which needs a Pub/Sub topic in the owner's Google Cloud project, publish rights for `gmail-api-push@system.gserviceaccount.com` and a renewal at least every seven days. It isn't built; the scheduled sync reads the same history.

**Testing.** Until a test account is set up, the tests run against a mock built from Google's docs (`packages/testkit/src/mocks/gmail.ts`), which holds the metadata scope to its documented limits (no `q`, no `full` or `raw`), answers 401 without a valid access token, pages lists and history, expires history below a floor, and answers 404 for deleted messages. Every docs fact it relies on is listed with its URL, and what the docs leave out is in its assumptions, checked on the first live run. Google has no Gmail sandbox: for the nightly run, make a Google account for testing that holds only synthetic mail, create an OAuth client in a test Cloud project with the consent screen in Testing and that account as a test user, connect it with `gmail.metadata` only, and add `SANDBOX_GMAIL_CLIENT_ID`, `SANDBOX_GMAIL_CLIENT_SECRET` and `SANDBOX_GMAIL_REFRESH_TOKEN` as GitHub Actions secrets. Tokens in Testing expire after seven days, so when the run fails with `invalid_grant`, reconnect the test account and update the secret.

### Google Workspace and Drive

Reads the Drive folder a business shares with Brain A, the Sheets ranges it lists and the appointments on the calendars it names, for finance and compliance (which invoices, statements and certificates exist and when they changed), buying and pricing (a price list or stock count kept in a sheet) and clienteling (who is booked, and when). It never downloads a file, and never keeps an appointment's title, description, location, meeting link or anybody's address.

**Scopes.** The account is connected with three read-only scopes and nothing else: `https://www.googleapis.com/auth/drive.metadata.readonly` (names, types, folders, sizes and times; it can't download contents), `https://www.googleapis.com/auth/spreadsheets.readonly` (only needed when `GOOGLE_SHEETS_RANGES` is set) and `https://www.googleapis.com/auth/calendar.events.readonly` (only needed when calendars are read). The client checks the `scope` field of every token Google issues and stops if it holds anything else, including read-only scopes that reach more than it needs: `drive.readonly` can download every file and `calendar.readonly` reads sharing and settings. It also stops if a needed scope is missing, since users can untick scopes on Google's consent screen. Read-only is enforced in code as well: the client sends five GETs (`changes.getStartPageToken`, `changes.list`, `files.list` with one folder query built from a checked id, `values:batchGet` for listed spreadsheets and ranges only, `events.list` for listed calendars only), each with a fixed `fields` list so owners, sharing, links, titles and descriptions aren't even sent, and throws on anything else before it is sent. Its one POST is the token refresh to `oauth2.googleapis.com`. Writes it may do later (`create_document`, `create_calendar_event`) are declared and stay behind the write gate.

**One Google app.** It uses the same OAuth client as Gmail (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), refreshes tokens the same way and keeps any refresh token Google returns in the same sealed store, but holds its own refresh token, `GOOGLE_WORKSPACE_REFRESH_TOKEN`: each connector stops if its token holds a scope beyond its own, so one token can't serve both. Enable the Drive, Sheets and Calendar APIs in the same Cloud project. `drive.metadata.readonly` is a restricted scope, with the same rules as Gmail's: no Google verification for an **Internal** consent screen in the business's own Workspace organization; otherwise verification and a security assessment before production use, and refresh tokens that **expire after 7 days** while the consent screen is in **Testing**.

| Setting | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The instance's Google OAuth client, shared with Gmail |
| `GOOGLE_WORKSPACE_REFRESH_TOKEN` | The refresh token from connecting with the three read-only scopes and `access_type=offline` |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | The shared folder; everything below it is read |
| `CORRESPONDENT_HASH_KEY` | The instance's key for correspondent references, shared with Gmail. `npm run secrets:setup` generates it |
| `GOOGLE_DRIVE_SHARED_DRIVE_IDS` | Optional. Whole shared drives to read as well |
| `GOOGLE_DRIVE_FILE_NAMES` | Optional. `keep` (the default) or `drop`, for files named after customers |
| `GOOGLE_SHEETS_RANGES` | Optional. `spreadsheetId/Sheet!A1:F500` entries, comma-separated; the only spreadsheet values read |
| `GOOGLE_CALENDAR_IDS` | Optional. `primary` (the default), `none`, or calendar ids, comma-separated |
| `GOOGLE_PUSH_CHANNEL_TOKEN` | Optional, generated. Verifies push notifications once push channels are turned on |

**What it reads.** Drive: the first pass takes a change token for My Drive and for each shared drive, then walks the shared folder (and each shared drive) folder by folder, 1,000 items a page, keeping every folder and each file changed in the last five years. Drive search can't ask for everything below a folder, so the walk keeps the set of folders it has seen (at most 20,000; past that it stops and asks for a narrower folder). Later passes read Drive's change feed from the saved token and keep changes whose parent is a known folder: edits, renames and moves are new versions, trashing and moving out are `document.file_removed`, and a folder moved in is walked for what it brings. A permanent deletion that Drive reports with only an id is kept for known folders; for a file it can't be told apart from one outside the shared folder, so it's left out. Sheets: each listed spreadsheet's ranges are read in one `values:batchGet` per pass, unformatted with dates as text; an unchanged range is a duplicate. Calendar: the first pass lists each calendar's appointments ending in the last five years, without expanding repeats; later passes read only what changed with Calendar's sync token, cancellations included. When Calendar answers 410 the calendar is listed again from five years back. An incremental pass with no checkpoint of its own starts like the import, so nothing is missed between the two.

**Quota.** Sheets allows 60 reads a minute per user, so the client paces Sheets to 50; Calendar to 500 a minute (of 600); Drive well under its 325,000 units a minute. 429s and rate-limit 403s are retried with backoff up to 64 seconds, honouring `Retry-After`; a daily limit stops the sync until the next round, which resumes from the checkpoint.

**Events.** `document.file_updated` keeps the file id, name, MIME type and kind (folder, spreadsheet, document, presentation, pdf, image, file), parent folder, shared drive, modified time and size. `document.file_removed` says why (`trashed`, `removed`, `moved_out`). `document.sheet_range_read` keeps the range's cells (at most 20,000, each cut to 500 characters). `calendar.appointment_updated` and `calendar.appointment_cancelled` keep the appointment id, status, start and end, created and updated times, type, busy or free, whether it repeats, the series and original start of an instance, the organizer and each attendee as a correspondent reference with their response (at most 50, with the full count), and a count of responses.

**Personal data.** File names are kept unless `GOOGLE_DRIVE_FILE_NAMES=drop`. File contents, owners, sharing and links are never fetched. Appointment titles, descriptions, locations, meeting links, attachments and attendee names are never requested, and the normalizer drops them if they arrive. Every address (attendees, organizer, a calendar id) becomes `correspondent:<hash>`, the same HMAC-SHA256 under `CORRESPONDENT_HASH_KEY` that Gmail uses, so a customer's appointments line up with their mail without either keeping the address. Sheets ranges are kept as listed, because the owner chose them: list ranges without customers' details; a cell holding only an email address is replaced by its reference.

**Push.** Drive (`changes.watch`) and Calendar (`events.watch`) can notify the instance of changes. Opening a channel is a POST that creates state in the business's Google account and points Google at the instance, so it is declared as two gated writes, `watch_drive_changes` and `watch_calendar_events`, rather than allowed as a read: until an owner adds them to `ENABLED_WRITES` no channel exists, and the scheduled sync reads the same changes anyway (Google says notifications aren't fully reliable, so the sync would still be needed). Google doesn't sign notifications: each is an empty POST whose headers name the channel and resource and echo the channel's token. `googlePushVerifier` checks `X-Goog-Channel-Token` against `GOOGLE_PUSH_CHANNEL_TOKEN` in constant time, that `X-Goog-Channel-ID` and `X-Goog-Resource-ID` name a channel the instance opened and that it hasn't expired, that `X-Goog-Resource-State` is one Google documents for that kind, and refuses a message number at or below the last one seen on the channel as a replay. A valid notification is only a prompt to run the incremental sync.

**Testing.** Until a test account is set up, the tests run against a mock built from Google's docs (`packages/testkit/src/mocks/google_workspace.ts`), which enforces each API's documented scopes, answers 401 without a valid access token, pages files, changes and events, keeps per-stream change feeds, expires sync tokens with 410, and returns whole resources (owners, titles, descriptions, links) so the tests check the connector drops them. Its assumptions are listed in the mock and checked on the first live run. Google has no Workspace sandbox: for the nightly run, make a Google account for testing that holds only a synthetic folder, spreadsheet and calendar, create an OAuth client in a test Cloud project with the consent screen in Testing and that account as a test user, connect it with the three read-only scopes, and add `SANDBOX_GOOGLE_WORKSPACE_CLIENT_ID`, `SANDBOX_GOOGLE_WORKSPACE_CLIENT_SECRET`, `SANDBOX_GOOGLE_WORKSPACE_REFRESH_TOKEN`, `SANDBOX_GOOGLE_WORKSPACE_FOLDER_ID` and `SANDBOX_GOOGLE_WORKSPACE_SHEETS_RANGE` (one `spreadsheetId/Sheet!A1:C10` entry) as GitHub Actions secrets. When the run fails with `invalid_grant`, reconnect the test account and update the secret.

### HubSpot

Reads HubSpot's CRM API for one account, pinned to the 2026-09 date version (HubSpot moved to date-based versions in 2026; each one keeps working until its end-of-life date). Read-only is enforced twice. Before its first read the client asks HubSpot which scopes the token holds (`POST /oauth/v2/private-apps/get/access-token-info`) and refuses to sync if any of them is more than a read scope, or if one of the four it needs is missing. And it sends four kinds of request only: that lookup, CRM searches, archived list reads and batch association reads. Each is checked against an allowlist, and each search body against the one shape the connector builds, before anything leaves the server. The writes it may do later (update contacts and deals, log activities) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `HUBSPOT_ACCESS_TOKEN` | The access token of a private app holding exactly `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read` and `crm.objects.tickets.read`. HubSpot puts calls, emails, meetings, notes and tasks under the contacts scope. The older `tickets` scope can change tickets, so a token holding it is refused |
| `HUBSPOT_WEBHOOK_SECRET` | Optional. The private app's client secret, which signs webhook deliveries |

**What it reads.** Companies, contacts, deals, tickets, then calls, emails, meetings, notes and tasks. For each, CRM search reads what changed (`lastmodifieddate` for contacts, `hs_lastmodifieddate` for the rest), oldest first, 200 per page, and the list endpoint then reads archived records 100 per page as deletions, since search never returns them. Deals, tickets and engagements are linked to their contacts, companies or deals with batch association reads of 100 ids. The historical import reads changes from the last five years. Incremental syncs read from where the previous pass started, less ten minutes, because search is fed from an index that can lag a change; with no checkpoint the first pass looks back 48 hours. Each pass reads changes up to the moment it started, so paging stays stable while records change.

**Search's 10,000 cap.** One search query can page through at most 10,000 results. The connector never gets near that: after each full page it starts a new query from the page's newest modified time, and the checkpoint lists the ids already read at exactly that time so they aren't read twice. Only a page whose records all share one time is paged with HubSpot's offset. If more than 10,000 records ever changed in the same millisecond the sync stops with an error rather than skip any.

**Rate limits.** Private apps get 100 requests per 10 seconds (190 on Professional and Enterprise) and a daily allowance per account, and search allows five requests a second. Searches are spaced 200 ms apart. A 10-second limit or a 5xx is retried with backoff, three tries; the daily limit (`policyName: DAILY`) stops the sync with a message, and the next run resumes from its checkpoint.

**Events.** Contacts become clienteling `customer.profile_updated` events, with the contact's first and last name as the only personal detail and marketing consent always off, since subscription and legal-basis data isn't read. The rest keep a neutral CRM shape: `crm.company_updated` (name), `crm.deal_updated` (name, pipeline, stage, amount in whole cents, currency, close date, contacts and companies), `crm.ticket_updated` (pipeline, status, priority, contacts and companies), `crm.engagement_logged` (kind, time, contacts and deals) and `crm.record_deleted`. Each event is keyed by object, id and last modified time, and a deletion by when it was archived, so each version is stored once and a replay is a duplicate. No email addresses, phone numbers, addresses, ticket subjects or bodies, notes, email bodies, meeting descriptions or call recordings are requested or kept.

**Webhooks.** `verifyHubSpotWebhook` checks `X-HubSpot-Signature-v3`, the base64 HMAC-SHA256 of method, URI, raw body and `X-HubSpot-Request-Timestamp`, keyed with the app's client secret and compared in constant time, and refuses a timestamp more than five minutes off, so a captured delivery can't be replayed. `hubSpotWebhookChanges` lists the contact, company, deal and ticket changes for one account, leaving property values out. A delivery is a prompt to sync, not data. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** The tests run against a mock built from HubSpot's docs (`packages/testkit/src/mocks/hubspot.ts`), which answers 401 without the token, enforces search's filter, page size and 10,000-result limits, returns contacts' default properties (email included) whatever was asked for, and lists its assumptions. For the nightly run, create a free HubSpot developer test account, add a private app with the four read scopes above, and add its token as the `SANDBOX_HUBSPOT_ACCESS_TOKEN` GitHub Actions secret.

### Inventory and POS systems

Reads CSV exports from any point-of-sale system out of a folder: item lists, stock counts, customer lists and sales lines. Nothing is sent to or read from the POS itself, so there is nothing to write back and no webhooks.

| Setting | What it is |
| --- | --- |
| `POS_IMPORT_DIR` | The folder the exports are dropped into, outside any git repo |
| `POS_MAPPING_PROFILE` | Optional. `generic`, or the path to a mapping profile JSON in the client's private instance repo |

**Mapping profiles.** A profile names the file patterns for each kind of export, the column for each value, the delimiter, the date order (`mdy`, `dmy` or `ymd`), the store's UTC offset for times written without one, and the system's own payment and category labels. `parsePosProfile` validates one and says which field is wrong. Each column can list several header names; headers match without regard to case or spacing. A profile's `id` is part of every idempotency key, so it must not change once data is imported. Profiles for one client's system belong in that client's instance repo, never here.

The generic profile reads these files and columns. Columns marked * are required; a file missing one stops the sync with the file and the columns named.

| File name contains | Columns |
| --- | --- |
| `item` or `inventory` | SKU*, Title*, Cost*, Retail Price*, Category, Metal, Karat, Weight (g), Quantity, Vendor, On Memo, Received |
| `stock` or `on hand` | SKU*, On Hand*, Date |
| `customer` or `client` | Customer ID*, Name*, Marketing Opt In, Updated |
| `sale`, `transaction` or `receipt` | Sale ID*, Date*, SKU*, Quantity*, Unit Price*, Discount, Sale Total, Payment Method, Customer ID, Salesperson, Channel, Original Sale ID, Return ID |

Only `.csv` and `.txt` files are read. Items are read first, then stock, customers and sales, each in name order.

**What it reads.** Each sync reads the files that are new or changed since the last one. The checkpoint holds each finished file's SHA-256 and, for a file in progress, how many of its events are stored, so a crash resumes mid-file. A changed file is read again from the top, and its unchanged rows come back as duplicates. Files that leave the folder are dropped from the checkpoint. The historical import and incremental syncs work the same way. Rows dated more than five years back are skipped.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `inventory.received` | Each item row with stock. A row with quantity 0 (a piece already sold) is skipped | profile and SKU, so each piece is received once |
| `inventory.counted` | Each stock row: what was on hand on that date | profile, SKU and date |
| `customer.profile_updated` | Name and marketing consent. Consent is never assumed: an empty column is no | profile, customer and a hash of name and consent, so only a real change is a new event |
| `sale.completed` | Sale lines grouped by Sale ID. The export's Sale Total wins over the lines' sum, since it can include tax | profile and sale |
| `sale.returned` | Lines with a negative quantity, grouped by Return ID, or by Sale ID when there is none. A receipt with both (an exchange) gives a sale and a return | profile and return |

Money reads `$1,250.00`, `1250.5` and `(25.00)` without floating point. Metal and karat come from the Metal column (`14K Yellow Gold` is gold, 14k); an unknown metal is kept as `posMetal`. Categories and payment labels map to the departments' values by keyword, after the profile's own labels. Exports list a tender per line, so a sale whose lines name different tenders gets one `other` payment. Rows without a date use the file's modified time, except sales, which need one.

A value that can't be read is left null, so the department schema dead-letters the row with the raw event kept, and every event carries `sourceRow` (`file.csv:12`) to find it. Only mapped columns are read: email addresses, phone numbers and street addresses in an export are never stored.

**Testing.** The tests use synthetic exports only. The CSV reader in `packages/connectors/src/files` (RFC 4180 quoting, CRLF, byte-order marks) and its money, date and flag parsers are shared with the bank statement connector.

### Monday.com

Reads monday.com's GraphQL API (`https://api.monday.com/v2`), pinned to API version 2026-07 with the `API-Version` header, so a new current version can't change answers under the connector. Retail, wholesale and manufacturing businesses track custom orders, repairs and production on monday.com boards; the connector brings every board the token can see into the brain as neutral work-tracking events.

| Setting | What it is |
| --- | --- |
| `MONDAY_API_TOKEN` | A monday app's OAuth token (safer) or a personal API token. It goes in the `Authorization` header as monday.com shows, with no `Bearer`, and nowhere else |
| `MONDAY_OAUTH_SCOPES` | Optional. For an OAuth token, the scopes it was granted, such as `boards:read updates:read`. The connector refuses to run if any could change data |
| `MONDAY_ALLOWED_COLUMNS` | Optional. Comma-separated `board:column` pairs whose display text may be kept although the column's type can hold personal data |
| `MONDAY_WEBHOOK_SIGNING_SECRET` | Optional. The monday app's Signing Secret, for when webhooks are turned on |

**Read-only.** The client sends only seven named read queries built in code (boards, the first and next pages of a board's items, with or without display text, a board's activity log, and updates), and every variable is checked before anything is sent: one board id at a time, page sizes within monday.com's limits, cursors and times in their own shapes, and the items filter only as one of the connector's own last-updated windows. A caller can't pass GraphQL text, and a mutation can never be sent. Which token to use matters:

- A **monday app's OAuth token** granted only `boards:read` and `updates:read` is limited by monday.com itself, so nothing can be changed whatever the code does. The token is opaque and doesn't say its scopes, so set `MONDAY_OAUTH_SCOPES` to the scope field from the token response; the connector refuses a token listed with any scope that isn't `:read`. These tokens don't expire until the app is uninstalled. monday.com's newer OAuth 2.1 flow, with expiring tokens and refresh tokens, isn't supported yet.
- A **personal API token** carries every permission its user has in the monday.com UI and can't be limited. The allowlist above is then all that keeps the connector read-only, so use the token of a user with no more access than the boards to sync.

The writes it may do later (`create_item`, `update_item`) are declared and stay behind the write gate.

**What it reads.** Boards are read 25 at a time with `state: all`, so archived and deleted boards arrive as `work.board_updated` with their state, columns (id, type and title) and groups. Items are read from every board that isn't deleted, 500 a page with `items_page` and then `next_items_page`. The historical import reads each board whole and keeps items updated in the last five years, then every update created in that time, 100 a page. `items_page` returns active items only, so items archived or deleted before the import aren't read. Only classic boards are listed (monday.com's default for `boards`), and subitems aren't read yet.

**Incremental syncs.** monday.com can't filter items by an exact time, only by periods such as today and yesterday in the token user's time zone (`__last_updated__` with `compare_attribute: "UPDATED_AT"`). Each pass asks for the smallest pair that surely covers everything since the previous pass started, less five minutes of overlap: today and yesterday up to 22 hours back, this and last week up to nearly seven days, this and last month up to nearly 28 days, and the whole board after that. It then keeps only items updated since then. Each board's activity log for the same span gives `work.item_deleted` for `delete_pulse` and `archive_pulse` events, and updates are read by creation day, a day wider each side because monday.com doesn't say which time zone it reads them in. With no checkpoint the first pass looks back 48 hours.

**Cursors.** `items_page` cursors expire 60 minutes after the first request. The checkpoint keeps the board and when its cursor was issued; a pass resumed more than 55 minutes later, or told the cursor expired, reads that board again from its start, and the items already stored are duplicates. A board whose cursor expires twice in one run stops the sync, which resumes from the checkpoint.

**Rate limits.** monday.com meters complexity points per minute (10M shared for a personal token, 5M each for reads and writes with an app token, 1M on free and trial accounts), calls per minute and per day (1,000 a day on the free, Basic and Standard plans), and requests at once. A complexity, minute, concurrency or IP limit is waited out for the `retry_in_seconds` monday.com sends, or its `Retry-After`, at most a minute and three times. The daily limit stops the sync with a message, and the next run resumes from its checkpoint. A pass costs one call per page of boards, one per page of items and one per activity log page on each board, and one per 100 updates, so on the free plan keep the sync interval long enough for the number of boards.

**Events.** `work.board_updated`, `work.item_updated` (board, group, state, created and updated times, creator and column values by column id and type), `work.item_deleted` (with `reason` `deleted` or `archived`) and `work.comment_updated`. Departments map a board's columns onto their own stages and dates. Each item is keyed by item id and `updated_at`, so each version is stored once and a replay is a duplicate.

**Personal data.** Column values are kept only for types that hold no free text: status (label, index, done), date (the day), numbers, checkbox, dropdown labels, timeline (two days) and people (user and team ids, never names). Text, long text, email, phone, location, file, link and every other type are dropped, and the item queries don't even ask for their text unless a column on that board is in `MONDAY_ALLOWED_COLUMNS`; then only that column's display text is kept, cut to 500 characters. Item names are never read, since they often hold a customer's name. Updates keep their id, item, creator and times; their words are never asked for. The activity log's data is read for the item id only.

**Webhooks.** `mondayWebhookChallenge` answers the challenge monday.com sends when a webhook is created. `verifyMondayWebhook` checks the JWT monday.com puts in the `Authorization` header of deliveries for webhooks a monday app creates: HS256 only, signed with the app's Signing Secret, compared in constant time, with an `exp` that hasn't passed (30 seconds' leeway), so a captured delivery can't be replayed later, and `aud` when one is given. Anything but ok must be answered 401. Webhooks set up another way may arrive unsigned. `mondayWebhookChanges` lists the board, item and kind of change. A delivery is a prompt to sync, not data. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** The tests run against a mock built from monday.com's docs (`packages/testkit/src/mocks/monday.ts`), which answers 401 without the right token, checks the API version, reads each request's operation and answers only the connector's named read queries with their documented argument types, refuses and counts every mutation, returns only the fields a query selects, filters by the last-updated periods, pages boards, items, activity logs and updates, expires items cursors after 60 minutes and sends rate limits. Its assumptions are listed in the mock and checked on the first live run. For the nightly run, create a free monday.com developer account with a few test boards, create a monday app there with only the `boards:read` and `updates:read` scopes, install it and add its OAuth token as the `SANDBOX_MONDAY_API_TOKEN` GitHub Actions secret.

### Plaid

Reads one linked bank (a Plaid Item) through Plaid's API, pinned to API version 2020-09-14 with the `Plaid-Version` header so a Dashboard default can't change it. Every Plaid endpoint is a POST, so read-only is enforced by an allowlist in the client: it calls `/accounts/get`, `/transactions/sync`, `/item/get` and `/webhook_verification_key/get`, and rejects anything else, such as `/transfer/create`, `/item/remove` or `/processor/token/create`, before a request is built. Those three are declared as writes (create a transfer, remove the Item, create a processor token) and stay behind the write gate. Link the bank with the transactions product only.

| Setting | What it is |
| --- | --- |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | The team's keys from the Plaid Dashboard. The secret is the one for the environment below. Both go in the `PLAID-CLIENT-ID` and `PLAID-SECRET` headers, never in a request body, so a logged body or an echoed error can't carry them |
| `PLAID_ACCESS_TOKEN` | The Item's access token, from exchanging the public token Plaid Link returns. It doesn't expire |
| `PLAID_ENVIRONMENT` | `sandbox` (`https://sandbox.plaid.com`) or `production` (`https://production.plaid.com`), with no default. An access token that names the other environment (`access-sandbox-...` with `production`) is rejected |

**What it reads.** Each pass reads the accounts and their balances with `/accounts/get`, then pages through `/transactions/sync`, 500 changes at a time, until Plaid says there are no more. The historical import starts with no cursor, which gives the Item's whole history: up to 24 months, as much as was asked for when the bank was linked (the connector asks for 730 days, which Plaid applies only if transactions haven't started for the Item). Incremental syncs carry on from the Plaid cursor the last pass ended on; the first one carries on from where the import ended. The checkpoint keeps both the cursor for the next page and the one the current loop began with, because when Plaid reports `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` its guidance is to start the loop again from the cursor that began it. The connector does that up to three times; pages already stored come round again as duplicates. An Item whose transactions aren't ready yet answers with an empty cursor, and the next pass reads from the start.

**Errors.** A rate-limited call (HTTP 429 or `RATE_LIMIT_EXCEEDED`) is retried three times, waiting 1, 2 and 4 seconds, then left to `runSync`. `ITEM_LOGIN_REQUIRED` isn't retried by the client: the error says to reconnect the bank in Plaid Link's update mode, and the access token stays the same. Errors carry Plaid's `error_type`, `error_code` and `error_message`, cut to 200 characters, with any credential taken out.

**Events.** Transactions arrive in the bank statements connector's shape, so finance reads a Plaid feed and a statement the same way.

| Event | From | Key |
| --- | --- | --- |
| `bank.transaction_imported` | Each posted transaction Plaid adds: account, account kind, signed amount in cents (money in positive, so Plaid's money-out-positive amounts are flipped), description, category (the bank statements rules), currency, merchant name, check number and Plaid's category | transaction, so finance counts it once |
| `bank.transaction_updated` | Each change Plaid reports to a transaction, in the same shape | transaction and a hash of what it says |
| `bank.transaction_removed` | Each transaction Plaid removes, naming the same `transactionId` | transaction |
| `bank.account_updated` | Each account: name, mask (its last four digits at most), type, kind, and current and available balances and limit in cents, in Plaid's sign | account and a hash of what it says, so unchanged balances are duplicates |

Pending transactions are skipped: a statement lists only posted ones, and Plaid removes a pending transaction when it posts and adds the posted one under a new ID. Removals stay with the bank events rather than QuickBooks' `accounting.record_deleted`, since a bank transaction isn't a book entry. No account numbers, routing numbers, owner names, emails, phones, locations, payment details (payee, payer, reference numbers) or counterparties are kept. A transaction with no readable date or amount is dead-lettered with the raw record kept.

**Webhooks.** `SYNC_UPDATES_AVAILABLE` says the Item has new changes without carrying them, so it is a prompt to sync, not data, and a replayed one finds nothing new. `verifyPlaidWebhook` checks the `Plaid-Verification` JWT before the body is parsed, with `node:crypto` only: the algorithm must be ES256 (`none` and everything else is rejected before a key is fetched), the key comes from `/webhook_verification_key/get` by the JWT's `kid` and must be a current P-256 key, the signature must hold, `iat` must be within five minutes, and `request_body_sha256` must match the SHA-256 of the raw body, compared in constant time. `plaidWebhookKeys` asks Plaid for each key once and treats an outage as an error rather than a forgery. `plaidSyncPrompt` picks the prompt for this Item out of a verified body. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** Until a Plaid account is set up, the tests run against a mock built from Plaid's API reference (`packages/testkit/src/mocks/plaid.ts`), which checks the keys and access token, pages a change log by cursor, can fail mid-loop, rate-limit or require a login, and signs webhooks with a key of its own. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, create a Sandbox Item linked to a Plaid test bank with the transactions product, and add `SANDBOX_PLAID_CLIENT_ID`, `SANDBOX_PLAID_SECRET` and `SANDBOX_PLAID_ACCESS_TOKEN` as GitHub Actions secrets. The check always uses the sandbox host.

### QuickBooks Online

Reads the QuickBooks Online Accounting API, pinned to minor version 75 (Intuit retired 1 to 74 in August 2025). Intuit has no read-only accounting scope, so read-only is enforced in the client: it sends GET requests to the query and change data capture endpoints only, rejects any query that isn't a `SELECT`, and its only POST is the token refresh to Intuit's sign-in service. The writes it may do later (create invoices, bills and journal entries) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` | The KaratOS app's keys from developer.intuit.com: Development keys for a sandbox company, Production keys for a client's |
| `QUICKBOOKS_REALM_ID` | The company's Company ID |
| `QUICKBOOKS_REFRESH_TOKEN` | The refresh token from connecting the company. It only seeds the instance's own copy (below) |
| `QUICKBOOKS_ENVIRONMENT` | `sandbox` or `production`, with no default, so a setting meant for one can't reach the other |
| `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN` | Optional. The app's webhook verifier token, for when webhooks are turned on |

**Tokens.** Access tokens last an hour and are refreshed five minutes early, one refresh at a time. Intuit rotates the refresh token about once a day and only the newest is sure to work, so each new one is saved before it's used. The instance keeps it in its database, sealed with AES-256-GCM under a key derived from the client secret and bound to the organization, so a database copy alone can't use it. If the stored token can't be read (the client secret was rotated, or the row was changed), or `QUICKBOOKS_REFRESH_TOKEN` is replaced after a reconnect, the setting is used again. Refresh tokens now expire five years after the company connects, and Intuit asks for reconnection before then. An `invalid_grant` error means the company needs reconnecting.

**What it reads.** The historical import queries the chart of accounts, customers and vendors (inactive ones too, which QuickBooks hides unless asked), then invoices, bills, payments and journal entries dated in the last six years, 1000 per page, ordered by Id. Incremental syncs query each entity for changes since the previous pass started, less five minutes so nothing saved mid-pass is missed, then ask change data capture for deletions, which queries don't return. With no checkpoint the first pass looks back 48 hours. Change data capture reaches back 30 days, so an instance that hasn't synced in 30 days misses older deletions, though it still reads every change.

**Events.** The books keep their shape under neutral types: `accounting.account_updated`, `accounting.vendor_updated`, `accounting.invoice_updated`, `accounting.bill_updated`, `accounting.payment_updated` (with the invoices each payment was applied to), `accounting.journal_entry_updated` (debit and credit lines with their accounts) and `accounting.record_deleted`. Customers become clienteling `customer.profile_updated` events with marketing consent off. Amounts become whole cents with the currency alongside. Each event is keyed by entity, Id and SyncToken, which QuickBooks raises on every change, so each version is stored once and a replay is a duplicate. No email addresses, phone numbers, addresses, tax IDs, memos or private notes are kept.

**Webhooks.** QuickBooks sends CloudEvents (Intuit moved every app to them by 31 July 2026), and a notification names what changed without the record itself. `verifyQuickBooksWebhook` checks `intuit-signature`, the base64 HMAC-SHA256 of the raw body keyed with the verifier token, and `quickBooksWebhookChanges` lists the changes for this company. A notification is a prompt to sync, not data, so a replayed one finds nothing new. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** Until an Intuit developer account exists, the tests run against a mock built from Intuit's docs (`packages/testkit/src/mocks/quickbooks.ts`), which rotates refresh tokens, rejects the old one, answers 401 without a valid access token, and parses only the queries the docs describe. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, create a free Intuit developer account and sandbox company, connect it to the app with its Development keys, and add `SANDBOX_QUICKBOOKS_CLIENT_ID`, `SANDBOX_QUICKBOOKS_CLIENT_SECRET`, `SANDBOX_QUICKBOOKS_REALM_ID` and `SANDBOX_QUICKBOOKS_REFRESH_TOKEN` as GitHub Actions secrets. The nightly run can't save the token Intuit rotates to, so when it fails with `invalid_grant`, reconnect the sandbox company and update that secret.

### Shopify

Reads the GraphQL Admin API (`https://<store>.myshopify.com/admin/api/<version>/graphql.json`). The app must be made in the Shopify Dev Dashboard by the store owner, so the app and store share an organization; otherwise the token request fails with `shop_not_permitted`. The version is pinned to `SHOPIFY_API_VERSION`, or to 2026-07, the version the connector was tested with. The client only sends queries, so a mutation is rejected before it leaves the server.

| Setting | What it is |
| --- | --- |
| `SHOPIFY_SHOP_DOMAIN` | The store's `myshopify.com` domain |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | The store's Dev Dashboard app, holding only `read_orders`, `read_all_orders`, `read_products`, `read_customers` and `read_inventory`. Without `read_all_orders`, Shopify returns only the last 60 days of orders. The connector exchanges them for an Admin API token (the client credentials grant), which lasts 24 hours, and renews it 5 minutes early or when Shopify revokes it |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Instead of the two above, only for a store that already has a custom app made in the admin. Shopify stopped letting merchants create those on 2026-01-01 |
| `SHOPIFY_API_VERSION` | Optional. Shopify supports each quarterly version for 12 months |
| `SHOPIFY_WEBHOOK_SECRET` | Optional. The app's client secret, which signs webhook deliveries |

**What it reads.** Orders with their refunds and fulfillments, then products with their variants and stock, then customers. Each stream is paged by `updated_at`, oldest first. The first import reads five years. The checkpoint records the stream, Shopify's page cursor and the latest `updated_at` seen, so a crash resumes at the next page and each incremental sync starts where the last one got to. An incremental sync with no checkpoint looks back 48 hours. If Shopify throttles a query, the client waits for its cost bucket to refill, using the `throttleStatus` Shopify returns, and gives up to `runSync` after three tries.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `order.updated` | Every version of an order: status, channel, total, line count | order and `updatedAt` |
| `sale.completed` | An order once it's paid, partly paid or refunded. It's in the sales department's shape, with `pos` orders as `store` and everything else `online` | order, so later edits never count the sale twice |
| `sale.returned` | Each refund that returns lines | refund |
| `fulfillment.updated` | Each fulfillment and its status | fulfillment and status |
| `product.updated` | Products with variant SKUs, prices and total stock | product and `updatedAt` |
| `customer.profile_updated` | Name and email marketing consent, in the clienteling shape | customer and `updatedAt` |

Only what the departments use is kept: no email addresses, phone numbers or street addresses. A line with no SKU uses `shopify-variant-<id>` instead. No sale is recorded for an order with more than 50 lines (its `order.updated` says `linesComplete: false`) or with a price that can't be read. A record that arrives without its timestamp is dead-lettered with the raw record kept.

**Webhooks.** `verifyShopifyWebhook` checks `X-Shopify-Hmac-SHA256` against the raw body before it's parsed. `handleWebhook({ topic, payload })` maps the REST-shaped delivery onto the same events the sync produces, so a webhook for a record already synced, or a redelivery, is a duplicate. Topics read: orders, refunds, products and customers.

**Testing.** The tests use synthetic, doc-shaped responses until the nightly sandbox run has a development store. To set one up, create a free development store and an app with the read scopes above in the same Shopify Dev Dashboard organization, then add `SANDBOX_SHOPIFY_SHOP_DOMAIN`, `SANDBOX_SHOPIFY_CLIENT_ID` and `SANDBOX_SHOPIFY_CLIENT_SECRET` as GitHub Actions secrets. Until those exist, the nightly run lists Shopify as skipped. The writes it may do later (adjust inventory, tag customers and orders, create draft orders) are declared, and the write-gate test shows each one is rejected.

### Slack

Reads the messages and threads in the channels the KaratOS app's bot has been invited to, through the Slack Web API, for sales (what the floor is talking about), repairs (job updates in a repairs channel) and custom orders (the threads around a commission). It reads nothing from a channel the bot isn't in, and no direct messages.

**The app.** The business makes its own app at api.slack.com/apps in its own workspace and doesn't distribute it. That keeps Slack's internal-app limits: conversations.history and conversations.replies are Tier 3 (50+ requests a minute, up to 1,000 messages a page). Since 29 May 2025, an app distributed to other workspaces that isn't in the Slack Marketplace gets Tier 1 for those two methods on every new installation, one request a minute and at most 15 messages a page, which makes a five-year import of a busy channel take days. Set `SLACK_APP_DISTRIBUTION=non_marketplace` only for an app installed that way; the connector then reads 15 a page and paces itself to one read a minute.

**Scopes.** Bot token scopes `channels:read` and `channels:history`, and `groups:read` with `groups:history` to read private channels the bot is invited to. Nothing else: not `chat:write` (posting), `users:read` (names and profiles), `files:read` (file contents), `im:history` or `mpim:history` (direct messages). The client checks the token with `auth.test` before its first read and reads the scopes Slack reports in the `x-oauth-scopes` header on that and every later answer; it stops if any scope beyond those four is there, if the private pair is incomplete, if the header is missing, or if `auth.test` names no bot (a user token). Read-only is also enforced in code: it sends `auth.test` (a POST, as documented, which changes nothing) and three GETs (`conversations.list`, `conversations.history`, `conversations.replies`), checks every argument, and throws on anything else, `chat.postMessage` included, before it is sent. The token goes in the Authorization header, never the URL. The writes it may do later (`post_recommendation`, `post_alert`, both `chat.postMessage`) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `SLACK_BOT_TOKEN` | The app's Bot User OAuth Token (`xoxb-`). User and app-level tokens are refused |
| `CORRESPONDENT_HASH_KEY` | The instance's key for people references, shared with Gmail. `npm run secrets:setup` generates it; don't rotate it, or history stops lining up |
| `SLACK_TEXT_CHANNELS` | Optional. `none` (the default), `all`, or channel ids separated by commas: the channels whose message text is kept |
| `SLACK_APP_DISTRIBUTION` | Optional. `internal` (the default) or `non_marketplace` |
| `SLACK_SIGNING_SECRET` | Optional. The app's signing secret, for Events API webhooks once the instance takes them |

**What it reads.** Each pass lists the workspace's channels, 200 a page, and keeps those the bot is a member of (up to 1,000). Then, channel by channel, it reads the history newest first, 200 a page, and for each thread parent the thread's replies, every page. The historical import reads five years back. Incremental syncs read each channel again from seven days before the previous pass started, because a new reply doesn't move its thread up the history, and read the replies only of threads with a reply since the previous pass. A channel the bot joined since the previous pass is read five years back. A reply to a thread more than seven days old reaches the brain through the Events API once the instance takes webhooks. With no checkpoint an incremental pass looks back 48 hours. The checkpoint holds the step, Slack's cursors and the channel list, so a crash resumes at the page it stopped on. A channel the bot was removed from mid-pass is skipped. 429s are waited out for their `Retry-After` (up to five minutes), five times, before the error goes to the sync, which resumes from the checkpoint.

**Events.** `communication.channel_updated` for each channel the bot is in: id, public or private, name, archived, created, member count and whether its text is kept. `communication.message_logged` for each message and reply: the channel, message and thread references, whether it's a reply, when it was sent, the author's reference (or the bot's id for an app's post), the kind (message, bot message, file share, thread broadcast, me message), reply, file and reaction counts, whether it was edited, and the text where kept. `communication.message_deleted` from a webhook. A message is keyed by channel, timestamp and a hash of its edit time and whether its text is kept, so an edit is a new version and a message seen by both the sync and a webhook, or replayed, is stored once. Join, leave, topic, purpose, rename and pin notices are skipped.

**Personal data.** Kept: ids, times, counts, channel names, and text only from the channels in `SLACK_TEXT_CHANNELS`. Every Slack user id becomes `slack_user:<hash>`, an HMAC-SHA256 under `CORRESPONDENT_HASH_KEY`, so the same person is the same reference everywhere but can't be identified or matched against another instance. Display names, profiles and email addresses are never read (there's no `users:read`). Kept text is cut to 12,000 characters before any pattern sees it and to 4,000 after, and is redacted in one pass: email addresses and `mailto:` links become `[email]`; phone numbers, `tel:` links and any run of seven or more digits (order, card and account numbers) become `[number]`, though dates like 2026-01-22, prices and ring sizes stay; links keep only their host (`[link: vendor.test]`); mentions of people become their reference. Files are counted, never fetched: no names, titles, previews or links. Reactions are counted without who reacted. Blocks and attachments are dropped. A channel name with four digits in a row is withheld.

**Webhooks.** `verifySlackWebhook` checks `X-Slack-Signature`: `v0=` and the hex HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<raw body>` under `SLACK_SIGNING_SECRET`, compared in constant time, and refuses a timestamp more than 300 seconds from now, before the body is parsed. `slackUrlVerification` gives the challenge to answer Slack's `url_verification`. `handleWebhook` turns a verified `event_callback` for a message posted, edited (`message_changed`) or deleted (`message_deleted`) in a channel or private channel into the same events the sync makes, so a webhook for a synced message, or a delivery Slack retries, is a duplicate. Subscribing needs the `message.channels` and `message.groups` bot events. The instance doesn't take webhooks yet; the scheduled sync picks up the same messages.

**Testing.** Until a sandbox is set up, the tests run against a mock built from Slack's docs (`packages/testkit/src/mocks/slack.ts`), which pages by cursor, filters channels by membership and scope, answers `not_in_channel`, `missing_scope`, `invalid_auth` and `ratelimited` the way the docs describe, and holds a non-Marketplace app to 15-message pages. What the docs leave out is in its assumptions, checked on the first live run. For the nightly run, join the Slack Developer Program, create a free developer sandbox workspace holding only synthetic messages, create an internal app there with the four read scopes above, install it, invite the bot to a test channel and a test private channel, and add the bot token as the `SANDBOX_SLACK_BOT_TOKEN` GitHub Actions secret.

### Stripe

Reads Stripe's REST API with GET requests only, pinned to `STRIPE_API_VERSION` or to 2026-09-30.endive, the version the connector was tested with. It accepts only a restricted key (`rk_`); a full secret key (`sk_`) can move money, so the client rejects it before sending anything.

| Setting | What it is |
| --- | --- |
| `STRIPE_SECRET_KEY` | A restricted key with Read on charges and refunds, disputes, payouts, balance, customers and events, and None on everything else |
| `STRIPE_WEBHOOK_SECRET` | The webhook endpoint's signing secret (`whsec_`) |
| `STRIPE_API_VERSION` | Optional. Leave empty to use the tested version |

**What it reads.** The historical import lists charges, refunds, disputes, payouts, balance transactions and customers created in the last five years, 100 per page, paging with `starting_after`. Incremental syncs read Stripe's events (20 types: charges, disputes, refunds, payouts and customers), which carry each changed object, then the balance transactions created since the last pass, because balance transactions have no events. Each pass starts from the newest record the last one saw. With no checkpoint it looks back 48 hours. Stripe keeps events for 30 days, so a pass never reaches further back than that; an instance that hasn't synced in 30 days needs a new historical import.

**Events.** Stripe records money movement, not what was sold, so its events keep Stripe's shape under Stripe-neutral types: `payment.charge_updated`, `payment.refund_updated`, `payment.dispute_updated`, `payout.updated` and `balance.transaction_recorded`. Customers become clienteling `customer.profile_updated` events with marketing consent off, since Stripe holds none. A charge is stored again only when its money changes (status, captured, refunded or disputed); balance transactions never change, so each is stored once. Amounts stay in Stripe's smallest currency unit, with the currency alongside. No email addresses, phone numbers, addresses, card numbers, descriptions or metadata are kept.

**Webhooks.** `verifyStripeWebhook` checks the `Stripe-Signature` header: HMAC-SHA256 of `<t>.<raw body>`, any one of several `v1` signatures (Stripe sends two while a secret rolls), and a timestamp within five minutes, so an old delivery replayed later is rejected. Webhooks and the events API carry the same event objects, so whichever arrives second is a duplicate.

**Testing.** The tests use synthetic responses shaped from Stripe's API reference. For the nightly sandbox run, create a restricted key with the read permissions above in test mode and add it as the `SANDBOX_STRIPE_SECRET_KEY` GitHub Actions secret. The writes it may do later (create payment links, create refunds) are declared, and the write-gate test shows each one is rejected.

### Xero

Reads the Xero Accounting API (`api.xro/2.0`) for one organisation. Read-only is enforced twice. The connection is granted read scopes only, and the client checks the scopes of every access token Xero issues and rejects to sync with one that could change data, so a connection set up with broader scopes stops with a message saying to reconnect. The client also sends GET requests to seven endpoints only, and its only POST is the token refresh to Xero's identity service. The writes it may do later (create invoices, bills and manual journals) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | The KaratOS app's keys from developer.xero.com (a Web app) |
| `XERO_TENANT_ID` | The organisation's tenant ID, from `GET /connections` after connecting |
| `XERO_REFRESH_TOKEN` | The refresh token from connecting the organisation. It only seeds the instance's own copy (below) |
| `XERO_WEBHOOK_KEY` | Optional. The app's webhooks key, for when webhooks are turned on |

**Scopes.** Connect with exactly `offline_access accounting.settings.read accounting.contacts.read accounting.invoices.read accounting.payments.read accounting.banktransactions.read accounting.manualjournals.read`. These are Xero's granular scopes, which apps created from 2 March 2026 must use.

**Tokens.** Access tokens last 30 minutes and are refreshed two minutes early, one refresh at a time. Xero retires the refresh token every time it's used and drops one that goes 60 days unused, so each new one is saved before anything else happens. The instance keeps it in its database, sealed the same way as QuickBooks' (AES-256-GCM under a key derived from the client secret and bound to the organization). If the stored token can't be read, or `XERO_REFRESH_TOKEN` is replaced after a reconnect, the setting is used again. An `invalid_grant` error means the organisation needs reconnecting.

**What it reads.** The historical import reads the chart of accounts and contacts (archived ones too), then invoices and bills, credit notes, payments, bank transactions and manual journals dated in the last six years, 1000 per page, oldest change first. Incremental syncs ask each endpoint for what changed since the previous pass started (`If-Modified-Since`), less five minutes so nothing saved mid-pass is missed; with no checkpoint the first pass looks back 48 hours. Xero keeps deleted and voided transactions with that status, so the same reads bring deletions. Xero doesn't stamp a few edits (a contact becoming a supplier, some due-date changes), so those arrive with the record's next stamped change.

**Rate limits.** Xero allows 60 calls a minute, 5 at once and a daily allowance per organisation. A minute limit is waited out (Xero's `Retry-After`, at most a minute, three tries); a daily limit stops the sync with a message, and the next run resumes from its checkpoint.

**Events.** The same neutral types as QuickBooks: `accounting.account_updated`, `accounting.vendor_updated` for suppliers, `accounting.invoice_updated` for sales invoices, `accounting.bill_updated` for bills, `accounting.credit_note_updated`, `accounting.payment_updated` (with the invoice or bill it was applied to), `accounting.bank_transaction_updated`, `accounting.journal_entry_updated` and `accounting.record_deleted`. Customers become `customer.profile_updated` events with marketing consent off; a contact that is both customer and supplier gives one of each. Amounts become whole cents with the currency alongside. Each event is keyed by endpoint, ID and `UpdatedDateUTC`, so each version is stored once and a replay is a duplicate. No email addresses, phone numbers, addresses, tax numbers, bank details or references are kept.

**Webhooks.** `verifyXeroWebhook` checks `x-xero-signature`, the base64 HMAC-SHA256 of the raw body keyed with the webhooks key. Anything but a match must be answered 401, which is also what Xero's intent-to-receive check expects. `xeroWebhookChanges` lists the invoice, contact and credit note changes for this organisation. A delivery names what changed without the record, so it is a prompt to sync, not data. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** The tests run against a mock built from Xero's docs (`packages/testkit/src/mocks/xero.ts`), which rotates refresh tokens, rejects the old one, issues access tokens carrying their scopes, answers 401 without a valid token, needs the tenant header and enforces paging, date filters and `If-Modified-Since`. For the nightly run, create a free Xero developer account, connect the Demo Company to an app with the read scopes above, and add `SANDBOX_XERO_CLIENT_ID`, `SANDBOX_XERO_CLIENT_SECRET`, `SANDBOX_XERO_TENANT_ID` and `SANDBOX_XERO_REFRESH_TOKEN` as GitHub Actions secrets. The nightly run can't save the token Xero rotates to, so expect it to fail with `invalid_grant` after its first use until the run can store tokens; reconnect and update the secret to check again.

<!-- registry:connector-docs:end -->

## Writing back: built, turned off

Every connector starts read-only. A connector may declare the write actions it could perform (`writes` on `Connector`), such as adjusting Shopify stock or creating a QuickBooks invoice, but each one runs through a `WriteGate`:

- The gate refuses any action the instance has not listed in `ENABLED_WRITES`, which is empty by default. Entries are `integration:action`, or `integration:*` for every action of one integration.
- Every attempt is audited, whether it was refused, performed or failed, with who asked for it.
- Connectors request only read scopes from vendors until a client agrees to writes.

So write support can be built and tested now, and switched on per client and per action later.
