# Integrations

The catalog lives in code at [`packages/core/src/integrations.ts`](../packages/core/src/integrations.ts). The first entries come from the original Brain A Integration Mapping sheet; the rest cover the wider stack that jewelry retailers, wholesalers and manufacturers run. Tests check two things: every setting an integration needs is documented in [`secrets/manifest.json`](../secrets/manifest.json), and every integration appears in the tables below.

`integrationsFor("retail" | "wholesale" | "manufacturing")` returns the systems a given kind of business is likely to run, which is where onboarding starts.

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

Used by: R is retail, W is wholesale, M is manufacturing. Access details for vendors marked Partner or Unknown still need confirming with the vendor before a connector is built.

### Point of sale and e-commerce

| Integration | Used by | Access | Webhooks | Status |
| --- | --- | --- | --- | --- |
| Shopify | R, W | Public API | Yes | Planned |
| Inventory and POS systems | R | File export | Yes | Planned (System-specific; CSV import first) |
| The Edge (Abbott Jewelry Systems) | R | Partner | No | Planned (No public API; partners use an on-premises connector. Start with scheduled exports) |
| Jewel360 | R | Partner | No | Planned (Partner integrations only. Start with exports) |
| ARMS | R | Unknown | No | Planned |
| Lightspeed Retail | R | Public API | Yes | Planned |
| Square | R | Public API | Yes | Planned |
| Clover | R | Public API | Yes | Planned |
| Valigara | R, W, M | Unknown | No | Planned |
| WooCommerce | R | Public API | Yes | Planned |
| BigCommerce | R, W | Public API | Yes | Planned |
| Wix | R | Public API | Yes | Planned |
| Punchmark | R | Partner | No | Planned |

### Diamonds, suppliers and grading

| Integration | Used by | Access | Webhooks | Status |
| --- | --- | --- | --- | --- |
| RapNet and the Rapaport Price List | R, W | Public API | No | Planned (Price list needs an active subscription) |
| IDEX Online | R, W | Public API | No | Planned |
| Nivoda | R, W | Public API | No | Planned (GraphQL; holds and orders need the Pro API) |
| VDB (Virtual Diamond Boutique) | R, W | Partner | No | Planned |
| Polygon | R, W | Unknown | No | Planned (Includes Memo-Track) |
| Stuller | R, M | Public API | No | Planned (Product, gem, order and invoice APIs) |
| GemFind JewelCloud | R, W, M | Partner | No | Planned |
| Quality Gold | R | Unknown | No | Planned |
| GIA Report Results | R, W, M | Public API | No | Planned (Needs a GIA lab account) |
| IGI report verification | R, W | Unknown | No | Planned (Web lookup only; no API found) |
| GemGuide Appraisal Software | R | Unknown | No | Planned |

### Pricing

| Integration | Used by | Access | Webhooks | Status |
| --- | --- | --- | --- | --- |
| Geller's Blue Book | R | Partner | No | Planned (Repair pricing; reached through the POS today) |
| nFusion Solutions metals feed | R, W, M | Public API | No | Planned |
| Metals-API | R, W, M | Public API | No | Planned |

### Customers, marketing and communication

| Integration | Used by | Access | Webhooks | Status |
| --- | --- | --- | --- | --- |
| HubSpot | R, W | Public API | Yes | Planned |
| Monday.com | R, W, M | Public API | Yes | Planned |
| Custom forms | R | Public API | Yes | Planned |
| Gmail | R, W, M | Public API | Yes | Planned |
| Google Workspace and Drive | R, W, M | Public API | Yes | Planned |
| Slack | R, W, M | Public API | Yes | Planned |
| Instagram DMs, Facebook Messenger and WhatsApp Business | R | Public API | Yes | Deferred (Waiting on Facebook account recovery) |
| Claude (Anthropic API) | R, W, M | Public API | No | Planned (Reasoning, not a data source) |
| Clientbook | R | Partner | No | Planned |
| Podium | R | Public API | Yes | Planned |
| Birdeye | R | Public API | No | Planned |
| Klaviyo | R | Public API | Yes | Planned |
| Attentive | R | Public API | Yes | Planned |
| Twilio | R, W | Public API | Yes | Planned |

### Money

| Integration | Used by | Access | Webhooks | Status |
| --- | --- | --- | --- | --- |
| Stripe | R, W | Public API | Yes | Planned |
| Chase business bank accounts and credit cards | R, W, M | File export | No | Planned (Manual CSV now; 5-6 years of PDF statements later) |
| QuickBooks Online | R, W, M | Public API | Yes | Planned |
| Xero | R, W, M | Public API | Yes | Planned |
| Plaid | R, W, M | Public API | Yes | Planned (Bank feeds beyond Chase) |
| Authorize.net | R, W | Public API | Yes | Planned |
| Affirm | R | Public API | Yes | Planned |
| Synchrony | R | Partner | No | Planned |
| Acima | R | Partner | No | Planned |
| Jewelers Board of Trade | W, M | Partner | No | Planned (Trade credit ratings) |

### Manufacturing and wholesale operations

| Integration | Used by | Access | Webhooks | Status |
| --- | --- | --- | --- | --- |
| PIRO | W, M | EDI | No | Planned |
| Adaptive Jewelry ERP | R, W, M | Unknown | No | Planned (Built on Microsoft Dynamics NAV) |
| Acumatica JewelShop | W, M | Public API | Yes | Planned |
| DiamTrade | W, M | Unknown | No | Planned |
| EDI with retail partners (X12 850, 855, 856, 810, 846, 852) | W, M | EDI | No | Planned (Purchase orders, ship notices, invoices, inventory and sell-through) |
| Jewelers Mutual care plans | R | Public API | No | Planned |
| Parcel Pro | R, W, M | Partner | No | Planned |
| Malca-Amit | W, M | Partner | No | Planned |

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
