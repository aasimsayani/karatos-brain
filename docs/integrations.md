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
| Clover | R | Public API | Free sandbox | Yes | Planned |
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
| HubSpot | R, W | Public API | Free sandbox | Yes | Planned |
| Monday.com | R, W, M | Public API | Free sandbox | Yes | Planned |
| Custom forms | R | Public API | Sample files | Yes | Planned |
| Gmail | R, W, M | Public API | Free sandbox | Yes | Planned |
| Google Workspace and Drive | R, W, M | Public API | Free sandbox | Yes | Built (Read-only scopes only. drive.metadata.readonly is restricted: an app outside one Workspace organization needs Google's verification before production use, and a consent screen left in Testing gives tokens that last seven days. Push channels stay behind the write gate; the scheduled sync reads Drive's change feed and Calendar's sync tokens) |
| Slack | R, W, M | Public API | Free sandbox | Yes | Planned |
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
| Affirm | R | Public API | Free sandbox | Yes | Planned |
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

- Authorize.net's Transaction Reporting requests on its JSON API
- Google Drive (files and changes, v3), Sheets (`values:batchGet`, v4) and Calendar (`events.list` with sync tokens, v3) with Google's token refresh, enforcing each API's documented scopes so `drive.metadata.readonly` can't read Sheets values
- Plaid's accounts, transactions sync, Item and webhook verification key endpoints (API version 2020-09-14), with webhooks signed the way Plaid signs them
- QuickBooks Online's query and change data capture endpoints with Intuit's token refresh (minor version 75)
- Stuller's invoice and metal market rate endpoints (API v2)
- Xero's Accounting API endpoints with its token refresh

Where a vendor has a free sandbox (Authorize.net, Google Workspace and Drive, Plaid, QuickBooks Online and Xero so far), its mock is a stand-in until a developer account is set up for the nightly run.

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
