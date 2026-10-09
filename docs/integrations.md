# Integrations

The catalog lives in code at [`packages/core/src/integrations.ts`](../packages/core/src/integrations.ts). The first entries come from the original Brain A Integration Mapping sheet; the rest cover the wider stack that jewelry retailers, wholesalers and manufacturers run. Tests check two things: every setting an integration needs is documented in [`secrets/manifest.json`](../secrets/manifest.json), and every integration appears in the tables below.

`integrationsFor("retail" | "wholesale" | "manufacturing")` returns the systems a given kind of business is likely to run, which is where onboarding starts.

## Build order: self-serve first

The first phase builds every integration we can finish without asking any vendor, company or person for anything: a public API with a free developer sandbox, or a file or EDI format we can test with synthetic samples. `selfServeIntegrations()` returns that list (27 systems today). Systems that need a paid subscription, a trade account or a partnership come later, once the core is built out.

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

### Point of sale and e-commerce

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| Shopify | R, W | Public API | Free sandbox | Yes | Planned |
| Inventory and POS systems | R | File export | Sample files | Yes | Planned (System-specific; CSV import first) |
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
| Metals-API | R, W, M | Public API | Free sandbox | No | Planned |

### Customers, marketing and communication

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| HubSpot | R, W | Public API | Free sandbox | Yes | Planned |
| Monday.com | R, W, M | Public API | Free sandbox | Yes | Planned |
| Custom forms | R | Public API | Sample files | Yes | Planned |
| Gmail | R, W, M | Public API | Free sandbox | Yes | Planned |
| Google Workspace and Drive | R, W, M | Public API | Free sandbox | Yes | Planned |
| Slack | R, W, M | Public API | Free sandbox | Yes | Planned |
| Instagram DMs, Facebook Messenger and WhatsApp Business | R | Public API | Free sandbox | Yes | Deferred (Waiting on Facebook account recovery) |
| Claude (Anthropic API) | R, W, M | Public API | Paid account | No | Planned (Reasoning, not a data source) |
| Clientbook | R | Partner | Partner | No | Planned |
| Podium | R | Public API | Unknown | Yes | Planned |
| Birdeye | R | Public API | Unknown | No | Planned |
| Klaviyo | R | Public API | Free sandbox | Yes | Planned |
| Attentive | R | Public API | Unknown | Yes | Planned |
| Twilio | R, W | Public API | Free sandbox | Yes | Planned |

### Money

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| Stripe | R, W | Public API | Free sandbox | Yes | Planned |
| Chase business bank accounts and credit cards | R, W, M | File export | Sample files | No | Planned (CSV exports, PDF statements or both, whichever the client prefers; 5-6 years of history) |
| Bank and credit card statements (any bank) | R, W, M | File export | Sample files | No | Planned (CSV, PDF or both, whichever the client prefers) |
| QuickBooks Online | R, W, M | Public API | Free sandbox | Yes | Planned |
| Xero | R, W, M | Public API | Free sandbox | Yes | Planned |
| Plaid | R, W, M | Public API | Free sandbox | Yes | Planned (Bank feeds beyond Chase) |
| Authorize.net | R, W | Public API | Free sandbox | Yes | Planned |
| Affirm | R | Public API | Free sandbox | Yes | Planned |
| Synchrony | R | Partner | Partner | No | Planned |
| Acima | R | Partner | Partner | No | Planned |
| Jewelers Board of Trade | W, M | Partner | Partner | No | Planned (Trade credit ratings) |

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

## Bank and card statements

Clients send statements whichever way suits them: CSV exports, PDF statements, or both (for example CSV for recent activity and PDFs for older years). `CHASE_IMPORT_MODE` takes `manual_csv`, `manual_pdf` or `manual_csv_and_pdf`, and other banks follow the same pattern. Both formats go through the same pipeline, and the statement connector must match transactions by account, date, amount and description so one that appears in both a CSV and a PDF is stored once.

Statements are customer data. They never go in a git repo, including private ones.

## Testing the integrations

Every system we connect to changes over time, so each connector is tested at four levels as it is built. None of this runs yet because no connector is built; it is the bar each one must meet:

| Level | What it checks | When it runs |
| --- | --- | --- |
| Unit | Normalizers turn recorded and synthetic payloads into valid events | Every push |
| Contract | Recorded responses from each vendor still match what the connector expects (fields, types, pagination, webhook signatures) | Every push |
| Live sandbox | Each connector runs a historical import and an incremental sync against the vendor's own sandbox, and a test webhook is delivered | Nightly |
| Docs watch | Each vendor's API changelog and version list is checked for changes, deprecations and new versions | Daily |

A failure at the live or docs level opens an issue naming the integration, what changed and the evidence. Sandbox credentials are test-only and live in the CI secret store, never in the repo. Synthetic fixtures contain no real customer data.

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
