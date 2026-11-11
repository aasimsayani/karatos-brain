# Integrations

The catalog lives in code at [`packages/core/src/integrations.ts`](../packages/core/src/integrations.ts). The first entries come from the original Brain A Integration Mapping sheet; the rest cover the wider stack that jewelry retailers, wholesalers and manufacturers run. A built connector's own catalog fields (status, note, capabilities and anything else it settles) are in `packages/core/src/catalog/<id>.ts`, next to nothing else. Tests check two things: every setting an integration needs is documented in [`secrets/manifest.json`](../secrets/manifest.json), and every integration appears in the tables below, which are generated from the catalog by `npm run registry:write`.

`integrationsFor("retail" | "wholesale" | "manufacturing")` returns the systems a given kind of business is likely to run, which is where onboarding starts.

## Build order: self-serve first

The first phase builds every integration we can finish without asking any vendor, company or person for anything: a public API with a free developer sandbox, or a file or EDI format we can test with synthetic samples. `selfServeIntegrations()` returns that list (69 systems today). Systems that need a paid subscription, a trade account or a partnership come later, once the core is built out.

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

The October 2026 wave widens the catalog three ways. Communication everywhere a customer reaches the store: Microsoft 365 and any IMAP mailbox beside Gmail, Teams, business phone and text, Zoom consultations, helpdesks, Apple Messages for Business, SMS marketing, and the review, loyalty and social sites where customers talk about the store. Jewelry-trade systems: secondhand and gold-buying reports to the police, HRD and GCAL reports, jewelry insurance, supplier invoices and memos with their Kimberley Process and System of Warranties statements, tray counts, wholesale marketplaces and the carriers that move high-value parcels. Running-the-business tools: bills and company cards, pay-over-time financing, ERP and manufacturing systems, staff schedules, task boards, signed agreements, shared files and store traffic counts. WhatsApp stays in the Meta entry, since it goes through the same Meta developer app. 1stDibs, Rio Grande and Yelp are left out for now: none offers a documented way to read a store's own data. Chrono24 comes in only through its dealer inventory feed and its ChronoPulse market index, listed in the tables below.

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
| Lightspeed Retail | R | Public API | Free sandbox | No | Built (Lightspeed Retail X-Series (formerly Vend), not R-Series. Read scopes only; the connector checks the scopes Lightspeed reports on every token and stops on any other. Sales, products, stock and customers use the same events as Square and Shopify) |
| Square | R | Public API | Free sandbox | Yes | Built (Read scopes only; the connector checks the token's scopes and stops on any other, so a full-access personal token won't do. Sales, refunds, items and stock use the same events as Shopify and the POS exports) |
| Clover | R | Public API | Free sandbox | Yes | Built (Connector in @karatos/connectors: orders, payments, refunds, items, stock and customers, read-only. Clover can't report an app's permissions, so the connector sends only its listed GET requests) |
| Valigara | R, W, M | Unknown | Unknown | No | Planned |
| WooCommerce | R | Public API | Free sandbox | Yes | Built (A REST API key with Read permission over https; the connector sends only GET requests to five read endpoints. Sales, refunds, products and stock use the same events as Shopify, Square and Clover) |
| BigCommerce | R, W | Public API | Free sandbox | Yes | Built (A store-level API account with read-only scopes. BigCommerce can't report a token's scopes, so the connector sends only GET requests to its listed paths. Sales, refunds, products and stock use the same events as Shopify, Square and Clover) |
| Wix | R | Public API | Free sandbox | Yes | Built (A self-managed Wix app holding read permissions only; the connector checks the permissions the site granted and stops on any Manage permission, and sends only eight listed read requests. Webhooks need the app (an API key gets none). Sales, products and stock use the same events as Shopify, Square and Clover) |
| Adobe Commerce (Magento) | R, W | Public API | Free sandbox | No | Planned (Orders, products, stock and customers through the REST API. Tested against a local Magento Open Source install, which is free) |
| Punchmark | R | Partner | Partner | No | Planned |
| Etsy | R, M | Public API | Paid account | No | Built (Connects with the shop owner's refresh token, granted transactions_r and listings_r only. After every refresh the connector asks Etsy which scopes the token has and stops if any could change data. Etsy has no sandbox: a developer's own shop confirms the mock built from Etsy's docs) |
| eBay | R, W | Public API | Free sandbox | No | Built (Connects with the seller's refresh token from an app the store owns. Every access token is asked for with sell.fulfillment.readonly alone, so eBay itself turns down any change, and the only API request is getOrders. No buyer details are kept, so no eBay user data is stored) |
| Amazon (Selling Partner API) | R, W, M | Public API | Free sandbox | No | Built (Connects through a private SP-API app the seller authorizes with the Finance and Accounting, and Amazon Fulfillment, roles. Its only API requests are three GETs (orders, transactions and FBA stock) and the Login with Amazon token refresh, and it never asks for the buyer or the address. Listings, returns and settlement reports are a follow-up. Amazon sends notifications through AWS queues rather than signed webhooks, so there is no webhook to verify) |
| TikTok Shop | R | Partner | Unknown | Yes | Planned (Orders, products and returns from TikTok's in-app shop, through an app registered in TikTok Shop Partner Center) |
| Faire | W, M | Public API | Unknown | No | Planned (Wholesale orders from independent boutiques through the Faire marketplace) |
| NuORDER | W, M | Public API | Unknown | No | Planned (B2B wholesale orders, line sheets and buyers, with API keys a brand approves in NuORDER Admin) |
| JOOR | W, M | Partner | Partner | No | Planned (B2B wholesale orders and buyers; JOOR's integrations team issues API tokens) |
| Squarespace Commerce | R | Public API | Paid account | Yes | Built (Connects with a Squarespace API key made with Read Only permission for Orders, Inventory and Products, which Squarespace lets each API have. The client sends only GET requests for those three lists. Custom API keys need the Commerce Advanced plan. Until a paid site is set up, the mock built from Squarespace's reference stands in) |
| Luxare | R, W, M | Unknown | Partner | No | Planned (Jewelry ERP, POS and repairs suite from Diaspark. No public API; partner only, start with scheduled exports. Found in jewelry industry sources) |
| The Jewelry Shopkeeper | R, W | File export | Sample files | No | Planned (Jewelry store POS with repairs, layaways and accounting. No public API; start with its daily sales and payables exports. Exhibited at JCK 2026) |
| Clarity Point of Sale | R | Unknown | Partner | No | Planned (Jewelry store POS with workshop jobs. No public API; partner only, start with scheduled exports. Exhibited at JCK 2026) |
| Gemist Designer | R | Partner | Partner | No | Planned (Custom ring designs, quotes, stone choices and order status. Partner only. Exhibited at JCK 2026) |
| JewelMate Enterprise Retail | R | Partner | Partner | No | Planned (Jewelry store POS and CRM with job envelopes, repairs and appraisals. Partner only. Exhibited at JCK 2026) |
| CaratIQ | R | Unknown | Partner | No | Planned (Cloud POS and clienteling for jewelers. No public API; partner only. Exhibited at JCK 2026) |
| Caratwise | R | Partner | Partner | No | Planned (Custom engagement ring design, quotes and leads sent to manufacturers. Partner only. Found in jewelry industry sources) |
| Thinkspace | R | File export | Sample files | No | Planned (Jewelry websites fed from the store's POS inventory, with web leads and orders. No public API; reached through the scheduled product feed. Found in jewelry industry sources) |
| Uploadify | R, W | Unknown | Paid account | No | Planned (Jewelry inventory, invoices, memos and marketplace listings. No API confirmed; paid account. Found in jewelry industry sources) |
| Flawless POS | R, W | Unknown | Partner | No | Planned (Jewelry POS with repairs, memo, RFID counts, appraisals and clienteling. No public API; partner only, start with scheduled exports. Exhibited at JCK 2026) |
| Crystal | R | Unknown | Partner | No | Planned (Cloud jewelry POS with serialized stock, memo, repairs, custom orders and layaways. No public API; partner only. Found in jewelry industry sources) |
| Guild Jeweler | R | Unknown | Unknown | No | Planned (Jewelry store management: inventory, appraisals, consignments and repairs. No API found; start with scheduled exports. Found in jewelry industry sources) |
| wJewel | R | Unknown | Unknown | No | Planned (Jewelry POS with layaways, appraisals, CRM and repairs. No API found; start with scheduled exports. Found in jewelry industry sources) |
| ChainDrive | R, W | File export | Partner | No | Planned (Retail management used by jewelry chains: sales, inventory and merchandising. No public API; start with scheduled exports. Found in jewelry industry sources) |
| iJewel3D | R, W, M | Public API | Free sandbox | No | Planned (Hosted 3D jewelry models, ring configurator and AR try-on. Public API with a free sandbox. No public API changelog found; the nightly sandbox run catches API changes. Likely exhibited at JCK 2026 as i-Jewel) |
| Whatnot | R, W | Public API | Paid account | Yes | Built (Reads with a seller API token the account owner creates in Whatnot's developer dashboard with only read:orders and read:inventory, and the client only ever sends GETs. Whatnot's REST API has no sandbox: the first seller's account confirms the mock built from Whatnot's docs) |
| Kickflip jewelry configurator | R, M | Unknown | Unknown | No | Planned (Custom jewelry configurator: configuration summaries and engraving files per order. No API found. Found in jewelry industry sources) |
| Custom Ring Builder | R | Partner | Partner | No | Planned (Shopify ring builder with live diamond feeds. Partner only. Found in jewelry industry sources) |
| Keyideas RingBuilder | R | File export | Partner | No | Planned (Shopify ring builder with diamond and gemstone feeds. No public API; partner only, start with its CSV exports. Found in jewelry industry sources) |
| Chrono24 dealer inventory feed | R, W | File export | Paid account | No | Planned (A dealer-hosted inventory feed that Chrono24 pulls daily, so listings, prices and sold status stay in step. No public API; the feed is set up through a Chrono24 integration manager. Found in luxury watch trade research) |
| Elefta | R, W | File export | Paid account | No | Planned (Watch and jewelry dealer inventory with serial tracking, memos, repairs and marketplace sync. No public API; start with its CSV exports. Found in luxury watch trade research) |
| WatchTraderHub | R, W | Partner | Paid account | No | Planned (Dealer catalog that syncs products, prices and orders with Shopify. No public API; partner only. Found in luxury watch trade research) |
| Chronodesk | R | Unknown | Unknown | No | Planned (Watch retail inventory, invoices, margin-scheme tax and customers. No API found; start with scheduled exports. Found in luxury watch trade research) |
| WatchManager.app | R | Unknown | Unknown | No | Planned (Dealer inventory, customers, sales, invoices and suppliers. No API found; start with scheduled exports. Found in luxury watch trade research) |
| Loupe for Dealers | R | File export | Unknown | No | Planned (Lists, prices and monitors stock across Chrono24, eBay and the dealer's own site. No API; start with its CSV exports. Found in luxury watch trade research) |
| Bezel seller portal | R, W | Partner | Partner | No | Planned (Authenticated watch marketplace listings, offers and sales. No public API; partner only. Found in luxury watch trade research) |
| Grailzee | R, W | Partner | Partner | No | Planned (Weekly no-reserve watch auctions. No public API; partner only. Found in luxury watch trade research) |
| Wristcheck | R | Unknown | Unknown | No | Planned (Watch consignment, instant sale and listings. No dealer API or feed found. Found in luxury watch trade research) |
| The 1916 Company (WatchBox) | R | Unknown | Unknown | No | Planned (Pre-owned watch buyer and seller, tracked as a trade counterparty rather than a connector. No dealer API found. Found in luxury watch trade research) |
| Jomashop vendor integration | R, W | Partner | Partner | No | Planned (Orders, tracking, invoices and stock for approved Jomashop vendors. Vendor API for approved sellers; partner only. Found in luxury watch trade research) |
| WatchCharts Marketplace | R | Unknown | Unknown | No | Planned (One-watch-per-listing marketplace with price context. No bulk import, feed or API. Found in luxury watch trade research) |
| WristBook | R, W | File export | Sample files | No | Planned (Watch dealer inventory, cost basis, deals, consignor payouts and wish lists. No public API; start with its tax-ready exports. Found in watch industry sources) |

### Diamonds, suppliers and grading

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| RapNet and the Rapaport Price List | R, W | Public API | Paid account | No | Built (Reads the weekly Rapaport Price List for round and pear diamonds. Needs a Rapaport subscription that includes the price list; built against a mock from Rapaport's developer pages and checked live once an account is connected. Instant Inventory listings aren't copied, as Rapaport's terms forbid it) |
| IDEX Online | R, W | Public API | Paid account | No | Built (Reads the business's IDEX Onsite feed, the network diamonds it offers on its own website with its filters and markups, and records what was listed, repriced or sold. Needs an IDEX trading subscription with the Onsite add-on; built against a mock from IDEX's API pages and checked live once a key is connected) |
| Nivoda | R, W | Public API | Partner | No | Built (Reads the diamonds a saved Nivoda search finds, with grades, measurements and prices, and records what was listed, repriced or sold. Needs a Nivoda buyer account with API access, which Nivoda turns on by request; built against a mock from Nivoda's API help pages and checked on Nivoda's staging API first) |
| VDB (Virtual Diamond Boutique) | R, W | Partner | Partner | No | Planned |
| Polygon | R, W | Unknown | Unknown | No | Planned (Includes Memo-Track) |
| Stuller | R, M | Public API | Paid account | No | Built (Reads the invoices on the business's Stuller account and Stuller's metal market rates, with a developer login. Needs a Stuller account owner to make the login; built against a mock from Stuller's API help pages and checked live once a login is connected) |
| GemFind JewelCloud | R, W, M | Partner | Partner | No | Planned |
| Quality Gold | R | Unknown | Unknown | No | Planned |
| Rio Grande | R, M | Unknown | Paid account | No | Planned (Bench tools, findings, sheet and wire, and gemstones for the workshop. No public API found; orders and invoices arrive by email) |
| Retail Jewelers Organization (RJO) | R | File export | Sample files | No | Planned (Buying group with vendor programs, dating terms and rebates. No API; start with member statements and vendor program lists) |
| IJO buying group | R | File export | Sample files | No | Planned (Buying group with vendor programs and rebates. No API; start with member statements and vendor program lists) |
| GIA Report Results | R, W, M | Public API | Free sandbox | No | Built (Looks up each certificate number on the business's list once, then follows GIA's free changed-reports feed. GIA's free plan includes a sandbox key; lookups of reports the business didn't submit cost per lookup. The docs watch follows the API changelog, and the nightly sandbox run catches API changes) |
| IGI report verification | R, W | Unknown | Unknown | No | Planned (Web lookup only; no API found) |
| GemGuide Appraisal Software | R | Unknown | Unknown | No | Planned |
| HRD Antwerp report check | R, W | Public API | Partner | No | Built (Looks up each HRD report number on the business's list once through the public MyHRD API, then checks each night that the reports are still valid. HRD issues a token on request through MyHRD, free of charge as far as its docs say. HRD publishes no API changelog, so the docs watch follows the API guide) |
| GCAL report verification | R, W | Unknown | Unknown | No | Planned (Web lookup through GCAL by Sarine only; no API found) |
| AGL report verification | R, W | Unknown | Unknown | No | Planned (Colored stone and pearl reports from American Gemological Laboratories. Web lookup only; no API found) |
| Supplier invoices and memos | R, W, M | File export | Sample files | No | Built (CSV exports of invoices and memos from any supplier, read for memo terms and System of Warranties and Kimberley Process statements) |
| Overnight Mountings | R | File export | Sample files | No | Planned (Catalog downloads as Excel or CSV with images; no ordering API found) |
| Laravo | R, W, M | Partner | Partner | No | Planned (Normalized brand product data, codes and images mapped to the store's POS. Partner only. Exhibited at JCK 2026) |
| Lashbrook Builder | R, M | Unknown | Partner | No | Planned (Custom band configurations and special orders. Retailer API not confirmed; partner only. Exhibited at JCK 2026) |
| DiaTrue detectors | R, W, M | Unknown | Unknown | No | Planned (Lab-grown diamond screening results per parcel or piece. Device export not yet confirmed. Exhibited at JCK 2026) |
| DRC Guardian | R, W, M | Unknown | Unknown | No | Planned (Lab-grown diamond detection results for loose lots and set jewelry. Device export not yet confirmed. Exhibited at JCK 2026) |
| Sarine (Profile, Diamond Journey and report verification) | R, W, M | Partner | Partner | No | Planned (Grading report data, provenance and stone media per diamond. Partner only. Found in jewelry industry sources) |
| Gübelin Report Verification | R, W, M | Unknown | Unknown | No | Planned (Lab report lookup by document number and verification code. Web lookup only; no API found. Found in jewelry industry sources) |
| GSI report access | R, W, M | Partner | Partner | No | Planned (Final grading reports and live lab submission status. Partner only. Found in jewelry industry sources) |
| Tracr | R, W, M | Partner | Partner | No | Planned (Tracr IDs and origin confirmation for De Beers diamonds. Partner only. Found in jewelry industry sources) |
| Master Casting and Cad order system | R, M | Unknown | Unknown | No | Planned (Casting and 3D print orders, STL uploads, cost estimates and status. No API found. Exhibited at JCK 2026) |
| Bransom bsmart-links | R | Unknown | Partner | No | Planned (Jewelry POS with supplier price, image and product line feeds. No public API; partner only. Found in jewelry industry sources) |
| Vision360 (v360) | W, M | File export | Sample files | No | Planned (360 media per diamond, linked to stock number and certificate. No public API; files arrive by FTP. Found in jewelry industry sources) |
| Diatech Marketplace | W, M | Partner | Partner | No | Planned (B2B diamond and jewelry listings with memo, hold and offer trades. Partner only. Exhibited at JCK 2026) |
| GemCloud and Gemolith | W, M | Unknown | Unknown | No | Planned (Colored gemstone inventory, media and grading. No API found. Found in jewelry industry sources) |
| Get-Diamonds | R, W, M | Unknown | Partner | No | Planned (B2B polished diamond listings and online tenders. No public API; partner only. Exhibited at JCK 2022) |
| LGDeal | R, W | Unknown | Partner | No | Planned (B2B lab-grown diamond listings, orders and memos. No public API; partner only. Found in jewelry industry sources) |
| Yehuda Sherlock Holmes / Watson AI | R, W, M | Unknown | Unknown | No | Planned (Lab-grown diamond detection results captured through the device's app. Export not yet confirmed. Exhibited at JIS Spring 2025) |
| Hoover & Strong (refining and myAuction) | R, M | Unknown | Partner | No | Planned (Refining lots and settlements, metals orders and customer goods sold through myAuction. No public API; partner only. Exhibited at JIS Spring 2026) |
| WatchBase Data Feed | R, W | Partner | Partner | No | Planned (Reference specs, calibers and images for watch listings. Data feed by agreement with WatchBase; partner only. Found in luxury watch trade research) |
| Wholesalr.io | W | Unknown | Unknown | No | Planned (Invite-only dealer-to-dealer watch wholesale with tag alerts. No API found. Found in luxury watch trade research) |
| WorldWatch Market | W | Unknown | Unknown | No | Planned (Dealer network for sharing inventory and talking to other dealers. No API yet; bulk import is on its roadmap. Found in luxury watch trade research) |

### Pricing

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| Geller's Blue Book | R | Partner | Partner | No | Planned (Repair pricing; reached through the POS today) |
| nFusion Solutions metals feed | R, W, M | Public API | Paid account | No | Built (Reads nFusion's Market Data API with a token from the nFusion dashboard; the API is GET-only market data and the client only ever sends GETs. Access needs a service agreement or a free trial and there is no sandbox: the first live token confirms the mock built from nFusion's OpenAPI spec) |
| Metals-API | R, W, M | Public API | Free sandbox | No | Built (Spot prices for gold, silver, platinum and palladium in dollars per troy ounce. No public API changelog; the nightly sandbox run catches API changes) |
| Kitco metal prices | R, W, M | Partner | Partner | No | Planned (Spot prices many stores quote from. Data feeds are licensed, not public; nFusion and Metals-API cover live prices until a license is in place) |
| Tenoris | R, W, M | Partner | Partner | No | Planned (Category and price-point sales benchmarks from independent jewelers. Partner only. Found in jewelry industry sources) |
| Edge Retail Academy and Edge Pulse | R | Partner | Partner | No | Planned (Peer KPI benchmarks, inventory aging, turn and open-to-buy guidance. Partner only. Exhibited at Centurion) |
| TheWatchSearch (by TheWatchCloud) | R, W | File export | Sample files | No | Built (Reads the WhatsApp group chat exports the store already has, since TheWatchSearch publishes no API or export. A partner feed from TheWatchCloud comes later) |
| Search The Watch Market Business API | R, W | Public API | Paid account | No | Built (Reads market prices, days to sell and 13 weeks of price history for the references the store follows, with a Business API key on a paid plan. The first client's key confirms the mock built from the vendor's API reference) |
| ElixIQ.io (formerly WatchFind.io) | R, W | Unknown | Unknown | No | Planned (Turns dealer WhatsApp group messages into structured watch listings with alerts. No API or export documented; start with scheduled exports. Found in luxury watch trade research) |
| WatchCharts API | R, W | Public API | Paid account | No | Planned (Market prices, price history, retail prices and appraisals by reference. Public API on a paid, credit-based plan. Found in luxury watch trade research) |
| EveryWatch | R, W | Partner | Partner | No | Planned (Auction results, dealer listings and price analytics. Data through an enterprise program; partner only. Found in luxury watch trade research) |
| Chrono24 ChronoPulse index | R, W | Unknown | Unknown | No | Planned (Luxury watch market trend index built on Chrono24 sales. Web pages only; no download or API found. Found in luxury watch trade research) |
| Subdial price data | R | Unknown | Unknown | No | Planned (Watch price data and supply charts. No API found. Found in luxury watch trade research) |
| WatchAnalytics | R | Unknown | Unknown | No | Planned (Watch price indexes and valuation tools. No API found. Found in luxury watch trade research) |

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
| Birdeye | R | Public API | Paid account | No | Built (Reads reviews with the business's Birdeye API key. Birdeye has no read-only key, so the connector only ever calls Get Reviews. No sandbox: the first client's key confirms the mock built from Birdeye's docs) |
| Klaviyo | R | Public API | Free sandbox | Yes | Built (Read-only by allowlist: Klaviyo can't be asked which scopes a private key holds, so the connector sends only listed reads and the two read-only report queries. Webhooks need Advanced KDP or a Klaviyo app) |
| Attentive | R | Public API | Unknown | Yes | Planned |
| Twilio | R, W | Public API | Free sandbox | No | Built (Text message and call logs through a restricted API key with read permissions only. Message bodies are never kept, and no webhooks, since pointing a number's webhook at KaratOS would change how the store's line answers) |
| Yelp | R | Public API | Paid account | No | Planned (Business details, rating and up to three review excerpts per call; full reviews are not in the API. Yelp's API is now a paid plan with a trial) |
| The Knot Pro | R | Unknown | Paid account | No | Planned (Leads and reviews from engaged couples on The Knot and WeddingWire vendor listings. No public API found; start with the lead notification emails) |
| Calendly | R | Public API | Free sandbox | No | Built (Read-only: a personal access token with only the users:read and scheduled_events:read scopes, and the client sends only its three listed reads. No webhooks, since subscribing needs a paid plan and the webhooks:write scope; the sync polls instead) |
| Acuity Scheduling | R | Public API | Paid account | Yes | Planned |
| Mailchimp | R | Public API | Free sandbox | Yes | Built (A Mailchimp API key can't be limited to reading, so the client sends its five listed GET reads only and throws before anything else. Every read names the fields it wants, so names, phone numbers, addresses and merge fields never leave Mailchimp) |
| Google Analytics 4 | R, W | Public API | Free sandbox | No | Built (Connects with analytics.readonly only and stops if the token holds anything more. Its only API request is runReport for the one property in the settings, built from two fixed reports) |
| Google Ads | R | Public API | Free sandbox | No | Built (Google Ads has one scope, which can change campaigns, so the client keeps the connection read-only: its only API request is googleAds:search for the one account in the settings, built from one fixed report, and it never calls mutate. Connect it as a Google Ads user with Read only access. Production accounts need a developer token with Basic access) |
| Meta Ads | R | Public API | Free sandbox | No | Built (Connects with a system user token holding ads_read only, and stops if the token holds anything more. Its only API requests are the permissions check and the insights read for the one ad account in the settings, built from one fixed report) |
| Google Business Profile | R | Partner | Partner | No | Built (Reads the account's locations, their Google reviews and their daily views, calls, direction requests and website clicks. Google offers only the business.manage scope for these APIs, so the connection holds that scope alone and the client sends only GETs to three fixed paths. Google approves Business Profile API access per project on request) |
| Google Merchant Center | R | Public API | Free sandbox | No | Planned (Product listings, disapprovals and free listing clicks through the Merchant API, which replaced the Content API for Shopping in 2026) |
| Microsoft 365 Outlook mail and calendar | R, W, M | Public API | Paid account | No | Built (Read-only: the app is meant to hold Exchange's Application Mail.ReadBasic and Application Calendars.Read roles for one mailbox only, through RBAC for Applications, and the client stops if its token carries any permission that isn't a read one. Mail.ReadBasic can't see bodies, previews or attachments. Change notifications aren't built; the scheduled sync reads Graph's deltas. Microsoft Graph's changelog is watched through this entry) |
| Any other mailbox (IMAP) | R, W, M | Public API | Sample files | No | Built (Signs in with LOGIN and an app password over implicit TLS only (port 993 by default); STARTTLS and plaintext aren't supported. Opens folders with EXAMINE and fetches header fields with BODY.PEEK, so nothing is ever marked read. Tested against a scripted RFC 3501 server; the first live mailbox confirms each provider's folder names) |
| Microsoft Teams | R, W, M | Public API | Paid account | No | Built (Read-only: the app is meant to hold only ChannelMessage.Read.Group and ChannelSettings.Read.Group, the resource-specific consent permissions a team grants when it installs the app, so it reads that one team and nothing else, and the client stops if its token carries any permission that isn't a read one. Message text is never kept. Change notifications aren't built; the scheduled sync lists each channel's newest changes. Microsoft Graph's changelog is watched through the Outlook entry) |
| RingCentral | R, W, M | Public API | Paid account | Yes | Built (Reads one extension's calls, texts and voicemail with a JWT credential, under an app given only ReadCallLog and ReadMessages; the client stops if the token can do more. RingCentral's developer sandbox needs a paid account, so the first client's credential confirms the mock built from RingCentral's guide) |
| Quo (formerly OpenPhone) | R | Public API | Paid account | Yes | Built (Reads calls and texts with the workspace's Quo API key. Quo keys have full access, so the client only ever sends List calls and List messages. No sandbox: the first client's key confirms the mock built from Quo's docs) |
| Zoom | R, W, M | Public API | Paid account | Yes | Built (Reads the account's meeting history and who joined each meeting through a Server-to-Server OAuth app the account's admin makes, given only two report read scopes. The client checks each token's scopes and won't read with one that can change anything. Zoom keeps reports for paid plans only, so the first client's app confirms the mock built from Zoom's docs) |
| Gorgias | R | Public API | Paid account | Yes | Built (Reads tickets and messages as a Gorgias app connected with tickets:read; the client stops if the token has a scope that writes. Gorgias API keys carry their user's full permissions and Observers can't make one, so it uses an app made in Gorgias's partner portal. The first client's connection confirms the mock built from Gorgias's docs) |
| Zendesk | R, W, M | Public API | Paid account | Yes | Built (Reads Zendesk's incremental ticket and user exports with an admin-made OAuth token scoped to tickets:read and users:read; the client stops if the token has a scope that writes, and keeps each rotated refresh token encrypted in the instance's database. The first client's connection confirms the mock built from Zendesk's docs) |
| Apple Messages for Business | R | Partner | Partner | No | Planned (iMessage conversations with customers, reached through a messaging service provider Apple has approved) |
| Postscript | R | Partner | Partner | Yes | Planned (Shopify SMS marketing. Custom API access is limited to enterprise plans and integration partners) |
| Yotpo reviews and loyalty | R | Public API | Paid account | Yes | Built (Reads the store's reviews with its store ID and API secret, and its Loyalty members' points with the Loyalty GUID and API key when given. Neither can be limited to reading, so the client only ever sends a token request and two GETs. Yotpo has no sandbox: the first client's store confirms the mock built from Yotpo's docs) |
| Judge.me | R | Public API | Paid account | Yes | Built (Reads the shop's reviews with its domain and an API token: an OAuth token with read_reviews only, or the private token, which also writes. The client only ever sends GETs of the review list. Judge.me has no sandbox: the first client's shop confirms the mock built from Judge.me's docs) |
| Smile.io | R | Public API | Paid account | No | Built (Reads customers, points transactions and VIP tiers with a merchant API key made with read scopes only, which needs Smile's Plus or Enterprise plan. Referrals have no list in Smile's API. The first client's key confirms the mock built from Smile's docs) |
| Trustpilot | R, W | Public API | Paid account | No | Built (Reads the store's public service reviews and trust score with only a Trustpilot application's API key, which reaches only public endpoints and can't reply or invite; the API secret is never used. Product reviews and invitations need a business user's token, so they aren't read. API access needs Trustpilot's API module: the first client's business unit confirms the mock built from Trustpilot's docs) |
| Pinterest | R, M | Public API | Free sandbox | No | Built (Connects a Pinterest business account through an app the store owns, holding boards:read, pins:read and user_accounts:read only; the connector stops if the token holds anything more. Its only API requests are the Pin list and two analytics reads. Pinterest's analytics reach back 90 days, so the first import reads 90 days of metrics and every Pin) |
| TikTok | R | Public API | Free sandbox | No | Built (Connects the store's own TikTok account through an app the store owns, holding user.info.basic, user.info.stats and video.list only; the connector stops if the token holds anything more. Its only API requests are the profile read and the video list) |
| TikTok Ads | R | Public API | Free sandbox | No | Built (Connects with a long-lived advertiser token from a TikTok developer app made with read scopes only (Ad Account Information and Reporting). Its only API request is the report read for the one advertiser in the settings, built from one fixed report. No changelog page outside the browser-only developer portal; the nightly sandbox run catches API changes) |
| Yext | R | Public API | Free sandbox | No | Built (Connects with an API key of a Yext app the store owns, which should hold read access to Entities and Reviews only. Its only API requests are two GETs, the location list and the review list. Listing status and analytics are a follow-up. No public API changelog found; the docs watch follows the three doc pages the mock was built from) |
| Docusign | R, W, M | Public API | Free sandbox | Yes | Built (Read-only by its client: Docusign has no read-only scope, so it signs in with JWT Grant as a user that can't send envelopes, and sends only the sign-in, the user's accounts and envelope reads. It never downloads a document. Connect deliveries are verified with the configuration's HMAC keys) |
| Dropbox | R, W, M | Public API | Free sandbox | Yes | Built (Read-only: every token is asked for account_info.read and files.metadata.read only (and files.content.read for file imports), and the client stops if Dropbox reports more. Webhooks only say an account changed, so a verified one prompts the incremental sync. Dropbox publishes no API changelog; changes are announced on its developer blog) |
| Microsoft OneDrive and SharePoint files | R, W, M | Public API | Free sandbox | Yes | Built (Read-only: the app is meant to have Sites.Selected with the read role on one site, and the client stops if its token carries any permission that isn't a read one. Graph's notifications only say the drive changed, so one carrying the subscription's clientState prompts the incremental sync. Graph's one changelog is watched through the Outlook entry) |
| BLNG AI | R, M | Unknown | Unknown | No | Planned (Sketch-to-render jewelry design projects. No API found. Exhibited at JCK 2026) |
| Amptive | R, W, M | Unknown | Unknown | No | Planned (Jewelry digital marketing agency: campaign results, website leads and ad reports. No API; start with the reports it sends. Exhibited at JCK 2026) |
| Smart Age Solutions (SEO Genie, Smart Care app) | R | Unknown | Unknown | No | Planned (Jewelry web agency and Shopify apps, including care plan sales through its Smart Care app. No API found. Exhibited at JCK 2025) |
| Jewelers' Assist (RingOS, JewelAR and STL Master) | W, M | Unknown | Unknown | No | Planned (Ring builder, AR try-on and CAD file viewer. No API found. Exhibited at JCK 2026) |
| Instappraise | R | Partner | Partner | No | Planned (Cloud appraisal documents, item descriptions and values. Partner only. Found in jewelry industry sources) |
| GemIQ (GemLightbox and GemStudio) | R, W, M | Unknown | Paid account | No | Planned (Product photos, 360 videos and descriptions per item. No API confirmed; paid account. Exhibited at JCK 2026) |
| 3Design CAD | R, M | File export | Sample files | No | Planned (Jewelry CAD project files and renders. No API; read from exported files. Found in jewelry industry sources) |
| Diamond Relations CRM | R | Unknown | Unknown | No | Planned (Jewelry sales pipeline: deals by stage and follow-ups by salesperson. No API found. Found in jewelry industry sources) |
| GemFlow | R | Unknown | Unknown | No | Planned (Quotes sent after try-on appointments, with photos, specs and prices. No API found. Found in jewelry industry sources) |
| RhinoArtisan | R, M | File export | Sample files | No | Planned (Jewelry CAD plugin for Rhino with pricing and technical reports. No API; read from exported files. Exhibited at JCK 2022 as 2Shapes) |
| TiaraCAD | M | File export | Sample files | No | Planned (Jewelry CAD plugin for Rhino. No API; read from exported reports. Exhibited at JCK 2026) |
| eLUXE3D scanning | R, M | File export | Sample files | No | Planned (Precision 3D scans of customer pieces for CAD, restoration and records. No API; read from delivered scan files. Exhibited at JCK 2026) |
| Perfect Corp Jewelry Virtual Try-On API | R, W | Public API | Paid account | No | Planned (Ring, necklace and earring virtual try-on sessions. Public API on a paid plan. Found in jewelry industry sources) |

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
| PayPal | R, W | Public API | Free sandbox | Yes | Planned (Sales, refunds, fees and disputes from the Transaction Search API, which reaches back three years. New transactions can take up to three hours to show. PayPal publishes release notes per API, not one changelog; the nightly sandbox run catches API changes) |
| Signifyd | R | Public API | Paid account | Yes | Planned (Fraud decisions and chargeback outcomes for online orders, with webhooks for each decision. A sandbox team comes with a merchant account) |
| ClearSale | R | Partner | Partner | No | Planned (Fraud review and chargeback protection for online orders. API credentials come with a merchant contract) |
| Affirm | R | Public API | Free sandbox | Yes | Built (Read-only, though an Affirm key pair can't be limited to reading: the connector only sends GET requests for transactions, disputes and settlements. US accounts only for now. The docs watch follows the API changelog, and the nightly sandbox run catches API changes) |
| Sezzle | R | Public API | Free sandbox | Yes | Planned (Pay-in-four orders, captures, refunds and settlements, with a merchant sandbox. No public API changelog found; the nightly sandbox run catches API changes) |
| Synchrony | R | Partner | Partner | No | Planned |
| Acima | R | Partner | Partner | No | Planned |
| Progressive Leasing | R | Partner | Partner | No | Planned (Lease-to-own at checkout for customers who cannot get credit. Merchant portal reports today; the API is for partners) |
| Snap Finance | R | Partner | Partner | No | Planned (Lease-to-own and financing for customers with thin credit. Merchant portal reports today; the API is for partners) |
| Jewelers Board of Trade | W, M | Partner | Partner | No | Planned (Trade credit ratings) |
| Avalara AvaTax | R, W, M | Public API | Free sandbox | No | Built (Read-only by allowlist: an AvaTax license key can do anything the account can, so the client sends only its three listed reads, with filters it builds itself. No public AvaTax changelog; the nightly sandbox run catches API changes) |
| TaxJar | R, W | Public API | Paid account | No | Built (Reads order and refund transactions and nexus regions with the business's TaxJar API token. TaxJar has no read-only token, so the client only ever sends its five GETs. No free account to test with: the first client's token confirms the mock built from TaxJar's docs) |
| FinCEN Form 8300 cash reporting | R, W, M | File export | Sample files | No | Built (The store's Form 8300 filings log, kept as CSV. BSA E-Filing has no API, so a person files and KaratOS tracks what was filed) |
| Refiner and scrap settlement statements | R, W, M | File export | Sample files | No | Built (CSV exports from any refiner, and PDF statements from a refiner whose layout is in its profile) |
| Gusto | R, W, M | Public API | Free sandbox | Yes | Built (Read-only: the app holds only the payrolls:read scope, and after every token refresh the connector asks Gusto what the token may do and stops on any other scope or another company. Webhook deliveries only prompt a sync) |
| ADP Workforce Now | R, W, M | Partner | Partner | Yes | Planned (Payroll, commissions and staff costs. The API is open to apps listed on the ADP Marketplace) |
| Paychex Flex | R, W, M | Partner | Partner | No | Planned (Payroll, commissions and staff costs. Paychex issues API access to approved integration partners) |
| QuickBooks Desktop | R, W, M | File export | Sample files | No | Planned (Books many older stores still keep. The Web Connector needs software on the store's own computer, so start with exported reports) |
| LeadsOnline secondhand reporting | R | Partner | Partner | No | Planned (Gold and secondhand buys many US police departments require; LeadsOnline issues API credentials to point-of-sale partners) |
| BILL | R, W, M | Public API | Free sandbox | No | Built (Reads supplier bills, approvals, vendors and payments from BILL's v3 API with a developer app made for accounting data only. BILL has no read-only option, so the connector only ever reads. BILL's sandbox checks the sign-in and calls, and the docs watch follows the pages the mock is built from) |
| Ramp | R, W, M | Public API | Free sandbox | Yes | Built (Reads company card transactions with an app's client credentials and the transactions:read scope only, turning down a token granted anything more. The vendor docs watch follows Ramp's API changelog; until a Ramp sandbox is set up, the mock built from Ramp's docs stands in) |
| Klarna | R | Public API | Unknown | No | Planned (Pay-over-time orders, captures, refunds and settlement reports) |
| Afterpay | R | Public API | Partner | No | Built (Read-only, though an Afterpay Merchant ID and Secret Key can't be limited to reading: the connector only sends GET requests to List Payments. Sandbox credentials come from an Afterpay account manager) |
| cardONE Fintech | R | Unknown | Unknown | No | Planned (Payments and financing for jewelers; product still being confirmed. No API found. Exhibited at JCK 2026) |
| American First Finance | R | Partner | Partner | No | Planned (Consumer financing and lease-to-own: applications, funded contracts and settlements. Merchant partner only. Exhibited at JCK 2026) |
| Aurora Payments | R | Unknown | Unknown | No | Planned (Merchant card processing: transactions, batches, deposits and fees. No API confirmed; start with statements. Exhibited at JCK 2026) |
| Sola Payments (formerly Cardknox) | R, W | Public API | Free sandbox | No | Built (Reads the gateway's transaction report with one API key. Sola's keys can't be limited to reports, so the client only ever posts Report:All to the reporting address, never the gateway. Sola publishes no API changelog, so the vendor docs watch follows its reporting page and the nightly sandbox run catches changes; until a sandbox is set up, the mock built from Sola's docs stands in) |
| Wells Fargo Jewelry Advantage | R | File export | Paid account | No | Planned (Consumer financing program for jewelers. No API; start with merchant summary report exports. Exhibited at Centurion) |
| OWL Financial Group | R, W, M | Unknown | Unknown | No | Planned (Collateral loans for jewelers and the pledged pieces behind them. No API found. Exhibited at Centurion) |

### Manufacturing and wholesale operations

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| PIRO | W, M | File export | Sample files | No | Built (Job and casting tree reports exported as CSV. PIRO's EDI documents go through the EDI X12 connector, and its REST API is for custom integrations PIRO sets up) |
| Adaptive Jewelry ERP | R, W, M | Unknown | Unknown | No | Planned (Built on Microsoft Dynamics NAV) |
| Acumatica JewelShop | W, M | Public API | Unknown | Yes | Planned |
| DiamTrade | W, M | Unknown | Unknown | No | Planned |
| EDI with retail partners (X12 850, 855, 856, 810, 846, 852) | W, M | EDI | Sample files | No | Built (X12 files from the business's VAN or SFTP mailbox: purchase orders, acknowledgments, ship notices, invoices, inventory and sell-through) |
| Jewelers Mutual care plans | R | Public API | Partner | No | Planned |
| Parcel Pro | R, W, M | Partner | Partner | No | Planned |
| Malca-Amit | W, M | Partner | Partner | No | Planned |
| MatrixGold CAD | R, M | Unknown | Unknown | No | Planned (Custom design files and metal weight estimates) |
| Formlabs 3D printing | R, M | Unknown | Unknown | No | Planned (Print jobs for wax and resin models) |
| BriteCo jewelry insurance | R | Partner | Partner | No | Planned (Appraisals and insurance offered at the point of sale; reached through POS partners today) |
| Extend product protection | R | Partner | Partner | Yes | Planned (Protection plans sold online and the claims made on them; needs an Extend merchant account) |
| ShipStation | R, W | Public API | Paid account | Yes | Built (Reads shipments and labels with the account's API key. ShipStation has no read-only key: the key could also buy and void labels, so the client only ever sends GETs of the two lists. API access depends on the plan: the first client's account confirms the mock built from ShipStation's docs) |
| FedEx | R, W, M | Public API | Free sandbox | No | Built (Reads FedEx tracking for each number on the business's list until the package is delivered or returned, with FedEx's free Track API. FedEx's sandbox checks the sign-in and calls; the docs watch follows FedEx's announcements, and the nightly sandbox run catches API changes) |
| UPS | R, W, M | Public API | Free sandbox | No | Built (Reads UPS tracking for each number on the business's list until the package is delivered or returned, with UPS's free Tracking API. UPS's test environment checks the sign-in and calls; the docs watch follows UPS's published API files, and the nightly sandbox run catches API changes) |
| USPS | R, W, M | Public API | Free sandbox | Yes | Planned (Tracking for Registered Mail and other USPS parcels, with tracking event subscriptions. USPS publishes no changelog for its new APIs) |
| NetSuite | W, M | Public API | Paid account | No | Built (Reads items, vendors, sales and purchase orders, invoices, journal entries and stock by location with SuiteQL, signed in by OAuth 2.0 machine-to-machine with a certificate mapped to a role that can only view. The token asks only for the rest_webservices scope, and every query is a fixed SELECT. The first client's account confirms the mock built from NetSuite's docs) |
| Katana | M | Public API | Unknown | Yes | Planned (Manufacturing orders, materials, stock and costs for small makers) |
| Cin7 Core | R, W, M | Public API | Paid account | Yes | Built (Reads products, customers, suppliers, sales, purchases and stock by location with an API application's account id and key. Cin7 Core's docs describe no way to limit what an application can do, so the client only ever sends GETs of the six lists. The first client's account confirms the mock built from Cin7 Core's docs) |
| RightClick | W, M | Unknown | Partner | No | Planned (Cloud ERP for jewelry manufacturers and wholesalers: stock, bills of materials, job bags and costing. No public API; partner only. Exhibited at JCK 2026) |
| e-Jewelry for Business Central | R, W, M | Public API | Paid account | No | Built (Reads items, vendors, sales invoices and purchase invoices through Business Central's standard API v2.0, signed in service to service by a Microsoft Entra app given read-only permission sets in Business Central. Every call is a GET marked read-only. Memos, jobs and diamond records are e-Jewelry's own pages without a published API, so they wait for the first client's tenant) |
| Unbridaled OS | W, M | Unknown | Partner | No | Planned (Cloud ERP for diamond and jewelry houses: inventory and production. No public API; partner only. Exhibited at JCK 2023) |
| Cabrella Shipping Insurance | R, W, M | Partner | Partner | No | Planned (High-value shipping insurance: insured shipments, declared values and claims. Partner only. Exhibited at JCK 2026) |
| Brink's Global Services | R, W, M | Partner | Partner | No | Planned (Secure insured shipping of diamonds and jewelry: bookings, tracking, customs papers and invoices. Partner only. Exhibited at JCK 2026) |
| Gem Logic | R, W, M | Unknown | Unknown | No | Planned (Cloud jewelry ERP: counter sales, workshop jobs, memos, consignment and metal prices. No API found. Found in jewelry industry sources) |
| Zing by Jewelers Mutual (appraisals, claims and diamonds) | R | Partner | Partner | No | Planned (Appraisals, consumer claim files and diamond searches. Partner only. Found in jewelry industry sources) |
| JM Shipping Solution | R, W | Partner | Partner | No | Planned (Insured shipping labels, tracking and claims linked to store orders. Partner only. Found in jewelry industry sources) |
| BIG Network (Balance to Buy and SalesRep Direct) | R, W | Partner | Partner | No | Planned (POS data gathered from many jewelry POS systems: sales, on-hand and sell-through by vendor. Partner only. Found in jewelry industry sources) |
| Zillion watch insurance | R | Partner | Partner | No | Planned (Watch insurance enrolled by text at the point of sale. Retail partner program; partner only. Found in luxury watch trade research) |
| Lavalier | R | Partner | Partner | No | Planned (Personal watch and jewelry cover with online quotes. No API found; partner only. Found in luxury watch trade research) |
| Wax Collect (Chubb) | R | Partner | Partner | No | Planned (Collection insurance backed by Chubb. No API found; partner only. Found in luxury watch trade research) |

### Running the business

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| OFAC sanctions lists | R, W, M | Public API | Sample files | No | Planned (The US Treasury's sanctions lists, published as free downloadable files, for screening the large buyers and sellers an anti-money laundering program must check) |
| JSA crime alerts | R, W, M | File export | Sample files | No | Planned (Crime alerts and bulletins the Jewelers' Security Alliance emails its members. No API; read from the alert emails in the connected mailbox) |
| RFID and barcode tray counts | R, W, M | File export | Sample files | No | Built (Count exports from RFID readers and barcode scanners, saved as CSV, one row per tag) |
| Homebase | R | Partner | Partner | No | Planned (Staff schedules and time clock, so labor can be set against sales. API keys need the Enterprise plan and a request to Homebase support) |
| Deputy | R, W, M | Public API | Unknown | Yes | Planned (Staff rosters and timesheets, so labor can be set against sales or bench work) |
| Asana | R, W, M | Public API | Free sandbox | No | Built (Read-only: the client sends only its five listed GETs and names every field it reads. A personal access token can do whatever its user can, so make it as a user with access to only the projects to sync, or use an OAuth app limited to read scopes. No webhooks yet; the sync polls) |
| Trello | R, W, M | Public API | Free sandbox | No | Built (Read-only: a token authorized with scope=read, which the connector checks before every sync, turning away one that can write. The client sends only its six listed GETs and never asks for card names or descriptions. No webhooks yet; the sync polls) |
| Airtable | R, W, M | Public API | Free sandbox | No | Built (Read-only: the client sends only its four listed GETs and names every field it reads. It stops if an OAuth token has a write scope; a personal access token's scopes aren't reported, so make it with data.records:read and schema.bases:read only. No webhooks yet; the sync polls) |
| Notion | R, W, M | Public API | Free sandbox | No | Built (Read-only: the client sends only a search, a data source read and a query, and names every property it reads. Notion's API can't report a connection's capabilities, so make the connection with Read content only. No webhooks yet; the sync polls) |
| Verkada store traffic | R | Public API | Paid account | Yes | Built (Reads people in and out by hour from each camera's counting line with a read-only API key, traded for a 30-minute token. Occupancy Trends needs Verkada cameras with it turned on: the first client's organization confirms the mock built from Verkada's docs) |
| ShopperTrak | R | Partner | Partner | No | Planned (Door counts from mall and street store traffic counters, to compare footfall with sales. Data access goes through Sensormatic) |
| Reshyne | R, W | Partner | Partner | No | Planned (Cloud jewelry and watch repair management: work orders, status and vendor price lists. Partner only. Exhibited at JCK 2026) |
| Jewelers' Toolbox and Benchtrax | R, M | Unknown | Unknown | No | Planned (Repair and custom quotes, metal buying calculations and RFID bench job tracking. No API found. Exhibited at JCK 2026) |
| Jewelry Sales Academy | R | Unknown | Unknown | No | Planned (Sales training progress and course completions for the sales floor. No API found. Exhibited at JCK 2026) |
| DCA Learning | R | Unknown | Unknown | No | Planned (Online courses for sales associates and who has completed them. No API found. Found in jewelry industry sources) |
| KaratCare: Jewelry Repairs | R | Partner | Partner | No | Planned (Shopify repair app: repair pipeline, quotes, invoices and warranty records. Partner only. Found in jewelry industry sources) |
| Asiga Composer | M | Unknown | Unknown | No | Planned (3D printer build software: print jobs and build history for casting. Export not yet confirmed. Exhibited at JCK 2026) |
| JM Alarm Response Program (with Securitas) | R | Unknown | Unknown | No | Planned (Guard response to store alarms with Securitas: dispatch findings and incident reports. No API found. Found in jewelry industry sources) |
| The Watch Register | R, W | Partner | Paid account | No | Planned (Serial number checks against lost and stolen watches before buying or taking one in. API offered to larger businesses on request; partner only. Found in luxury watch trade research) |
| Art Loss Register | R, W | Unknown | Paid account | No | Planned (Due-diligence searches for stolen valuables; watches go to The Watch Register. No API published. Found in luxury watch trade research) |
| RepairDesk | R | Public API | Paid account | No | Planned (Repair tickets, intake checklists, warranty claims and serialized stock, used by watch repair shops. Public API on a paid plan. Found in luxury watch trade research) |
| RepairShopr | R | Public API | Paid account | Yes | Built (Reads with an API token given only the Tickets, Estimates and Invoices List/Search permissions, and the client sends only GET requests to those three lists. RepairShopr keeps no public API changelog, so the vendor docs watch follows its API docs instead; until a trial account is set up, the mock built from those docs stands in) |

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
- Afterpay's List Payments on its production and sandbox hosts, with Basic auth, created-date windows, ordering, limit and offset
- Airtable's whoami, list bases, base schema and list records endpoints (Web API v0)
- Amazon's Selling Partner API orders search (v2026-01-01), finance transactions (v2024-06-19) and FBA inventory summaries, with the Login with Amazon token refresh, enforcing the access token header, the app's roles, date ranges, page sizes and page tokens tied to their query
- Asana's current user, project, section, task and story endpoints (REST API 1.0)
- Authorize.net's Transaction Reporting requests on its JSON API
- AvaTax's connection check, company and transaction endpoints (REST API v2)
- Microsoft's client credentials sign-in and Business Central's API v2.0 lists of items, vendors, sales invoices and purchase invoices, with filters and next links
- BigCommerce's v2 order and store paths and v3 catalog, inventory, customer, refund and price list paths
- BILL's OAuth client credentials token and v3 vendor, bill and payment lists
- Birdeye's Get Reviews
- Calendly's current user, scheduled event and invitee endpoints (API v2)
- Cin7 Core's API v2 product, customer, supplier, sale, purchase and stock lists
- Clover's REST API v3 read endpoints with its v2 OAuth token refresh, including its 90-day cap on orders, payments and refunds
- Typeform's Create API (a form's definition) and Responses API
- Docusign's JWT Grant sign-in, user info and envelope status changes (eSignature REST API v2.1)
- Dropbox's token refresh, current account, folder listing and change feed, and download endpoints (API v2)
- eBay's Fulfillment API getOrders and createShippingFulfillment (Sell APIs, v1) with its OAuth refresh, enforcing the client credentials, the scopes the seller agreed to, the order filter, limit and offset
- Etsy Open API v3 token refresh, token scopes, and the shop's receipt and listing reads
- FedEx's OAuth client credentials token and Track API tracking-number call
- GIA's Report Results API: getReport and getChangedReports
- Gmail's message, label and history reads with Google's token refresh (API v1)
- The Google Ads API's `googleAds:search` and `googleAds:mutate` (REST, v26) with Google's token refresh, enforcing the developer token, the adwords scope, the account and manager headers, GAQL fields and page tokens tied to their query
- The Google Analytics Data API's `runReport` (v1beta) with Google's token refresh, enforcing analytics scopes, date ranges and the rule that item-scoped fields can't be mixed with session ones
- Google's token refresh and Google Business Profile's location list (Business Information v1), review list (v4) and daily metrics (Performance v1), with page sizes, page tokens and date ranges
- Google Drive (files and changes, v3), Sheets (`values:batchGet`, v4) and Calendar (`events.list` with sync tokens, v3) with Google's token refresh, enforcing each API's documented scopes so `drive.metadata.readonly` can't read Sheets values
- Gorgias's OAuth token, List tickets and List messages
- Gusto's payroll list and payroll endpoints with its token refresh and token_info
- HRD Antwerp's public MyHRD API: report data and report validity
- HubSpot's CRM search, archived list, batch association and token info endpoints (date version 2026-09)
- IDEX's Onsite feeds: the natural full feed and the lab-grown full file
- Judge.me's review list (REST v1)
- Klaviyo's mock covers its profile, list, segment, campaign, flow and metric reads and the campaign and flow values reports (revision 2026-10-15). Plaid's accounts, transactions sync, Item and webhook verification key endpoints (API version 2020-09-14), with webhooks signed the way Plaid signs them
- Lightspeed Retail (X-Series) token refresh and product, inventory, customer and sale reads
- Mailchimp's ping, audience, member, campaign and campaign report reads (Marketing API 3.0)
- Meta's Marketing API ad account insights and `/me/permissions` (Graph API v26.0), enforcing the token, ads_read, the ad account, campaign level by day, the fields and cursors tied to their read
- Microsoft's client credentials sign-in and Microsoft Graph's driveItem delta (v1.0)
- Microsoft's client credentials sign-in and Microsoft Graph's message and calendar view deltas (v1.0) for one mailbox, enforcing Mail.ReadBasic's hidden fields, the RBAC scope, state tokens and the calendar window
- Microsoft's client credentials sign-in and Microsoft Graph's listings of one team's channels, channel messages and replies (v1.0), enforcing the team the app is installed in, page sizes, skip tokens and the reply expansion
- monday.com's GraphQL API: boards, items, activity logs and updates
- NetSuite's OAuth 2.0 client credentials token and SuiteQL (REST web services v1)
- nFusion Solutions' Market Data API spot summary and daily spot history for gold, silver, platinum and palladium, with the token in the query string and its 403.502 rate limit
- Nivoda's GraphQL diamond search: sign-in, diamonds_by_query and get_diamond_by_id
- Notion's search, retrieve data source and query data source endpoints (API version 2026-03-11)
- Quo's List calls and List messages
- Pinterest's API v5 Pin list, account analytics, top Pins and Pin creation with its OAuth refresh, enforcing the client credentials, each token's scopes, the 90-day analytics window, page sizes, metrics and bookmarks tied to their list
- Plaid's accounts, transactions sync, Item and webhook verification key endpoints (API version 2020-09-14), with webhooks signed the way Plaid signs them
- QuickBooks Online's query and change data capture endpoints with Intuit's token refresh (minor version 75)
- Ramp's token and card transactions endpoints (Developer API v1)
- Rapaport's token service and Price List API: the full list and its changes
- RepairShopr's ticket, estimate and invoice lists (API v1)
- RingCentral's JWT sign-in, an extension's call log and its message store (REST API v1.0)
- Search The Watch Market's resolve, model prices, days to sell and history
- ShipStation's API v2 shipment and label lists
- Slack's auth.test, conversations.list, conversations.history and conversations.replies, with both rate-limit regimes (Web API)
- Smile.io's List VIP tiers, List customers and List points transactions
- Sola Payments' transaction report (Report:All)
- Square's read endpoints with its OAuth refresh and token status check (API version 2026-09-16)
- A Squarespace site's Commerce APIs: products (v2), inventory and orders, enforcing the key, its Read Only permissions, the User-Agent, cursors and the modified window
- Stuller's invoice and metal market rate endpoints (API v2)
- TaxJar's transaction and nexus reads
- TikTok's Display API v2 profile read and video list with its OAuth refresh, enforcing the client credentials, each token's scopes and the scope each field needs, page sizes and time cursors
- TikTok's API for Business synchronous report (Marketing API v1.3), enforcing the token, the advertiser, campaign level by day, the metrics, the 30-day range and paging
- Trello's token, member board, list, custom field, card and action endpoints (REST API 1)
- Trustpilot's public business unit and service reviews (v1)
- UPS's OAuth client credentials token and Tracking API details call
- Verkada's API token, occupancy trends cameras and occupancy trends
- The Whatnot Seller API's order, order item, product and variant lists (REST v2), with bearer tokens, scopes, cursors and direction
- A Wix site's read endpoints (eCommerce orders, Catalog V3 and V1, Contacts V5) with the app token, its permissions and cursor paging
- A WooCommerce store's REST API v3 read endpoints with its key permissions and page headers
- Xero's Accounting API endpoints with its token refresh
- Yext's Management API v2 location and review lists, enforcing the API key header, the version date, the account, the app's access, page sizes, update-date ranges and page tokens tied to their query
- Yotpo's access token, Retrieve all reviews (Reviews v1) and recently updated Loyalty customers (Loyalty v2)
- Zendesk's OAuth token refresh and its cursor-based ticket and user exports
- Zoom's Server-to-Server OAuth token, meeting history and meeting participant reports (API v2)

Where a vendor has a free sandbox (Affirm, Airtable, Amazon (Selling Partner API), Asana, Authorize.net, Avalara AvaTax, BigCommerce, BILL, Calendly, Clover, Custom forms, Docusign, Dropbox, eBay, FedEx, GIA Report Results, Gmail, Google Ads, Google Analytics 4, Google Workspace and Drive, Gusto, HubSpot, Klaviyo, Lightspeed Retail, Mailchimp, Meta Ads, Microsoft OneDrive and SharePoint files, Monday.com, Notion, Pinterest, Plaid, QuickBooks Online, Ramp, Slack, Sola Payments (formerly Cardknox), Square, TikTok, TikTok Ads, Trello, UPS, Wix, WooCommerce, Xero and Yext so far), its mock is a stand-in until a developer account is set up for the nightly run.

<!-- registry:mocks:end -->

### Vendor docs watch

Every integration in the catalog lists its vendor's public API changelog (`changelog` in `packages/core/src/integrations.ts`), or null when the vendor publishes none. The **Vendor docs watch** workflow runs daily:

- It fetches each changelog, and every page a doc-derived mock was built from (`docMockVendorDocsTargets(allDocMocks())`, keyed `integration:page`), and compares its readable text with the last run's copy. Scripts, styles and markup are ignored, so a site rebuild isn't a change.
- Everything it finds goes on one long-running issue, **Vendor docs watch**, labeled `vendor-docs`. Each run that finds something adds one comment with the removed and added lines for every page that changed, and what a moved page (404 or 410) needs. Other failures are listed in the run summary and retried the next day.
- The issue body is a checklist with one row per vendor, however many of its pages changed, listing its three newest pages with links to their evidence. The body stays under GitHub's size limit: if the rows don't fit, it shows them without their pages, then only the top rows with a count of the rest. Vendors a client syncs come first, then other built connectors, then the rest of the catalog, newest change first. The daily build works the top rows. Ticking a row marks it handled: the next run drops it, and a later change brings it back.
- Which systems clients sync comes from the `DOCS_WATCH_IN_USE` repository variable (comma-separated catalog ids), never from the repo, and the issue only uses it to order rows.
- A snapshot is saved only once its change is on the issue, so a run that can't reach GitHub reports the change again the next day.
- The first run, or a changed URL, only records a baseline.

Run it locally with `npm run build -w @karatos/core -w @karatos/connector-testkit && npm run docs:watch -- --dry-run`, which prints the issue body and comment it would write.

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
2. Add the day it lands to `CONNECTED_ON` in `site/directory.ts`, so the website's "Newest connections" shows it. The card shows "Connector built" and the capabilities straight from the catalog. A new catalog row also needs its one-line `SYSTEM_DETAILS` entry there; a site test names whichever is missing.
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

### Afterpay

Reads Afterpay's (Cash App Afterpay's) Merchant API v2 on its global hosts: `https://global-api.afterpay.com`, or `global-api-sandbox.afterpay.com` for a sandbox pair. Requests use HTTP Basic auth, with the Merchant ID as the user and the Secret Key as the password, and carry a User-Agent naming KaratOS. The same pair can capture, refund and void orders, and Afterpay doesn't offer credentials limited to reading. So read-only is enforced in the client: it sends one request, a GET of List Payments, with a query string it builds itself, and has no way to send anything else. A refund is declared as a write and stays behind the write gate.

| Setting | What it is |
| --- | --- |
| `AFTERPAY_MERCHANT_ID`, `AFTERPAY_SECRET_KEY` | The merchant's credentials, which Afterpay gives with the merchant account; sandbox and production each have their own pair |
| `AFTERPAY_ENVIRONMENT` | `sandbox` or `production`, with no default, so a setting meant for one can't reach the other |

**What it reads.** List Payments filters by when a payment was created, never by when it last changed. So the historical import reads every payment created in the last five years, oldest first, 250 a page, each with its current state and refunds. Each later sync reads again every payment created in the last 60 days, or since the last sync finished if that was longer ago, and stores only what changed. A refund on an order older than that isn't seen until the next historical import. Each page is a batch, and the checkpoint keeps the window and the offset. Afterpay publishes no rate limit. A 429 or 5xx is retried, honoring `Retry-After` up to a minute or else waiting 1, 2 and 4 seconds, before the sync stops and resumes from its checkpoint. A 401 says the pair is wrong for the environment.

**Events.** These use the same neutral types as Stripe and Affirm:

- `payment.charge_updated` for each Afterpay order: Afterpay's state alongside succeeded, pending or failed, the amount, what was captured and refunded in whole cents, the currency, and the store's own order number (`merchantReference`), so it can be matched to the sale.
- `payment.refund_updated` for each refund, linked to its order.

Each order is keyed by its id, its state and the amounts captured and refunded, so each step is stored once and a replay is a duplicate. A payment's order details carry the shopper's name, email, phone and addresses, plus the items. None of that is kept, nor the checkout token. A row that doesn't read is dead-lettered with what was wrong.

**Testing.** The tests run against a mock built from Afterpay's docs (`packages/testkit/src/mocks/afterpay.ts`). It answers the sandbox or production host only, checks the Basic pair and the User-Agent, refuses parameters the docs don't list, and filters, orders and pages as List Payments describes. Sandbox credentials come from an Afterpay account manager. Once a pair is set up, a nightly sandbox check replaces the mock's assumptions with recordings.

### Airtable

Reads Airtable's Web API (`https://api.airtable.com/v0`) with a personal access token: the bases the token can see (or the ones `AIRTABLE_BASE_IDS` names), each base's tables with their fields, and each table's records.

| Setting | What it is |
| --- | --- |
| `AIRTABLE_ACCESS_TOKEN` | A personal access token with only the `data.records:read` and `schema.bases:read` scopes, and access to only the bases to sync |
| `AIRTABLE_BASE_IDS` | Optional. The bases to read, by id, separated by commas; unset reads every base the token can see |

**Read-only.** The client sends only four GETs: `/meta/whoami`, `/meta/bases`, `/meta/bases/{baseId}/tables` and `/{baseId}/{tableId}`, with parameters it builds itself. Ids, page offsets and the filter's time are checked before they go into a request. Before reading, the connector asks `/meta/whoami` for the token's scopes, and an OAuth token with any write or manage scope stops the sync. Airtable doesn't report a personal access token's scopes, so the connector can't check one; make it with the two read scopes only. Creating and changing a record are declared behind the write gate, and the test shows each one is stopped.

**What it reads.** Airtable returns every field of a record when a request names none, so every records request names its fields by id, and a table with no field the connector reads is kept for its structure only. Any field that comes back without being asked for is dropped. The fields read are those whose values hold no free text: number, currency, percent, rating, duration, auto number, count, checkbox, date, date and time, created and last modified time, single and multiple select (their option labels) and links to other records (as record ids). Text, long text, rich text, email, phone, URL, attachment, collaborator, created and modified by, barcode, button, formula, rollup, lookup and AI text fields are never asked for. A table that names more than 200 readable fields has its first 200 read.

The first import reads records made or changed in the last five years, 100 a page. Each later sync asks only for records made or changed since the last pass started, less five minutes of overlap, with `filterByFormula` on `LAST_MODIFIED_TIME()` and `CREATED_TIME()`. Each batch's checkpoint records the base, the table and the page offset it got to, so a resumed sync carries on. Airtable's offsets expire; a table whose saved offset Airtable turns down (422 `LIST_RECORDS_ITERATOR_NOT_AVAILABLE`) is read again from its start, once, and what was already stored is a duplicate. A base or table deleted part way through a pass is skipped. A 429 is waited out for 30 seconds, as Airtable asks, three times, then left to `runSync`, which retries from the checkpoint. A 401 stops the sync saying the token was turned down; a 403 names the scopes it needs. Airtable doesn't report deleted records to a reader, so a deleted record is simply no longer read.

**Events.** The same vendor-neutral work-tracking events monday.com, Asana and Trello send, so a department reads them all the same way.

| Event | From | Key |
| --- | --- | --- |
| `work.board_updated` | A table: its name, its base as `airtable:base:<id>` and the base's name, and every field's id, type and name as columns, each marked with whether it is read | table and a hash of what was read |
| `work.item_updated` | A record: its table and base, when it was made, when it last changed (from a last modified time field, when the table has one), and its read field values | record and a hash of what was read |

Airtable gives a table no modified time and a record none unless the table has a last modified time field, so each version is keyed by a hash of what was read: a change is stored once and a replay is a duplicate. A table's event is timed when it was seen. A record whose created time doesn't read is dead-lettered.

**Webhooks.** None yet. The scheduled sync polls.

**Testing.** The tests run against a mock built from Airtable's API reference (`packages/testkit/src/mocks/airtable.ts`). Like Airtable, it returns every field when none are named and only the named ones otherwise, and leaves empty fields out, so the tests show a text field's value never comes back. It answers 401 for the wrong token, 403 for a base the token can't see, reports scopes as it does for an OAuth token, applies the changed-after filter, pages with `offset`, and can answer 429 and 422 for an expired offset. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, make a free Airtable workspace for testing only, add a base or two of synthetic records, make a personal access token with only the two read scopes and access to that workspace's bases, and add it as the `SANDBOX_AIRTABLE_ACCESS_TOKEN` GitHub Actions secret.

### Amazon (Selling Partner API)

Reads the store's Amazon seller account in one marketplace through the Selling Partner API (SP-API): its orders (Orders API v2026-01-01), the transactions Amazon posts to the account, such as sales, fees, refunds and transfers (Finances API v2024-06-19), and the stock in Amazon's warehouses (FBA Inventory API v1). Read-only by request: its only SP-API requests are three GETs with parameters it builds and checks itself, and its only other request is the Login with Amazon (LWA) token refresh. It never asks for the buyer or the shipping address.

| Setting | What it is |
| --- | --- |
| `AMAZON_SP_CLIENT_ID` | The LWA client id of a private SP-API app in the seller's own Seller Central account |
| `AMAZON_SP_CLIENT_SECRET` | The same app's LWA client secret, which Amazon asks to be rotated every 180 days |
| `AMAZON_SP_REFRESH_TOKEN` | The refresh token from authorizing the app (self-authorization) |
| `AMAZON_SP_MARKETPLACE_ID` | The marketplace to read; `ATVPDKIKX0DER` (Amazon.com) when unset |
| `AMAZON_SP_REGION` | `na` (default), `eu` or `fe`, the region the marketplace belongs to |
| `AMAZON_SP_ENVIRONMENT` | `production` (default) or `sandbox` |

**Setting it up.** In Seller Central, under Apps and Services, open Develop Apps and add a private SP-API app with only the Finance and Accounting role (orders and transactions) and the Amazon Fulfillment role (warehouse stock). Authorize it for the store's own account, generate a refresh token, and put the three credentials in the host's secret store. AWS request signing is no longer needed, so there is no AWS account to set up.

**What it reads.** Each pass reads, in turn, the orders Amazon last updated in a range of time, 100 a page, with their totals and fulfillment status; the transactions Amazon posted in the same range, in steps of up to 179 days because Amazon answers nothing for a range wider than 180; and every SKU's stock in Amazon's warehouses as it stands now. The range is the last two years on the first import, and on each sync after, the time since the last pass ended, starting two days early because Amazon can post a transaction up to two days late. Each range ends five minutes before the pass starts, since Amazon turns away a range ending less than two minutes before the request.

**Events.** `order.updated` for each order, with its status, who fulfils it (Amazon or the seller), its marketplace, its total and how many lines and units it holds, keyed by when Amazon last updated it. `sale.completed` for each order Amazon has taken payment for (unshipped, partly shipped or shipped) whose lines all have a SKU, a quantity and a price, keyed by order so a later update never counts the sale twice. `marketplace.transaction_posted` for each transaction, with its type, status, amount, top-level breakdown and the order it belongs to; a deferred transaction that is later released is a new version. `inventory.counted` for each SKU, counting the units ready to ship, with what is inbound, reserved and unsellable. Amounts are whole cents parsed from Amazon's decimals without floating point.

**Privacy.** The client asks only for each order's totals and fulfillment status, never the buyer, the recipient, the address or the payment. If Amazon sent any of them anyway, none is kept.

**Rate limits.** Amazon's order search allows one request every three minutes after a burst of 20, transactions one every two seconds after a burst of 10, and stock two a second. The client sends one request at a time and waits out a 429, a 500 or a 503, doubling from a second, three tries, before the error goes to the sync runner, which resumes from its checkpoint next time. An order page token lasts 24 hours; a stock page token lasts 30 seconds, so a stock step that was cut off starts again from its first page, and its unchanged counts are duplicates. An access token that has expired is renewed once; a second 403 means the app lacks a role.

**Webhooks.** Amazon sends notifications through AWS queues (SQS and EventBridge), not signed HTTP webhooks, so there is no webhook to verify. Incremental syncs pick up changes instead.

**Writes.** Changing a merchant-fulfilled listing's quantity and changing a listing's price are declared so they can be gated and audited, and are turned off. Each needs a named person's approval, and the client has no request to send either.

**Not yet read.** Listings, customer returns and settlement reports come from Amazon's asynchronous Reports API and are a follow-up.

**Testing.** The tests run against a mock built from Amazon's docs (`packages/testkit/src/mocks/amazon.ts`), which checks the LWA refresh, the access token header, the user-agent, the app's roles, date ranges and their two-minute rule, the 180-day transaction limit, page sizes, page tokens tied to their query, and the 30-second life of a stock token. For the nightly run, add a private app's sandbox credentials as the GitHub Actions secrets `SANDBOX_AMAZON_SP_CLIENT_ID`, `SANDBOX_AMAZON_SP_CLIENT_SECRET` and `SANDBOX_AMAZON_SP_REFRESH_TOKEN`.

### Asana

Reads Asana's REST API (`https://app.asana.com/api/1.0`) with an access token: the workspaces the token's user belongs to, each workspace's projects (archived ones too) with their sections, each project's tasks, and the comments on each task read.

| Setting | What it is |
| --- | --- |
| `ASANA_ACCESS_TOKEN` | A personal access token made by a user who sees only the projects to sync, or an OAuth app's token limited to read scopes |
| `ASANA_WORKSPACE_GID` | Optional. The one workspace to read; unset reads every workspace the user belongs to |

**Read-only.** The client sends only five GETs: `/users/me`, `/projects`, `/projects/{gid}/sections`, `/tasks` and `/tasks/{gid}/stories`, with parameters it builds itself. Ids and page offsets are checked before they go into a request, and the next page is asked for by its `offset`, never by following the `next_page` URI, so a reply can't send the token to another host. A personal access token can do anything its user can and can't be limited, so make it as a user added only to the projects to sync. Creating a task and commenting on one are declared behind the write gate, and the test shows each one is stopped.

**What it reads.** Every request names its fields with `opt_fields`, and none of them is a task's name or notes, a comment's text or a custom field's text. The first import reads tasks changed in the last five years, 100 a page. Each later sync asks only for tasks changed since the last pass started, less five minutes of overlap (`modified_since`). Each batch's checkpoint records the workspace, the project and the page offset it got to, so a resumed sync carries on. Asana's offsets expire; a resumed list whose offset Asana turns down is read again from its start, once, and what was already stored is a duplicate. A project deleted part way through a pass is skipped. A 429 is waited out for `Retry-After` seconds, up to a minute, three times, then left to `runSync`, which retries from the checkpoint. A 401 stops the sync saying the token was turned down; a 402 says the read needs a paid plan.

Asana doesn't count a new comment as a change to its task, so a comment on a task that otherwise didn't change is read with the task's next change. Subtasks aren't listed in a project unless they were added to it, so they aren't read.

**Events.** The same vendor-neutral work-tracking events monday.com sends, so a department reads both the same way.

| Event | From | Key |
| --- | --- | --- |
| `work.board_updated` | A project: its name, whether it's archived, start and due days, owner and team as `asana:user:<gid>` and `asana:team:<gid>`, its custom fields as columns and its sections as groups | project and `modified_at` |
| `work.item_updated` | A task: its project and section, kind (task, milestone or approval), whether it's done and when, created and modified times, start and due days and due time, assignee, parent task, and its custom field values | task and `modified_at` |
| `work.comment_updated` | A comment on a task: who wrote it and when | story and `created_at` |

Custom fields are kept only for types that hold no free text: number, single select and multi select (their option labels), date and people (as user ids). Text fields aren't asked for. Stories that aren't comments, such as a task being moved, are dropped. A record whose time doesn't read is dead-lettered.

**Webhooks.** None yet. The scheduled sync polls.

**Testing.** The tests run against a mock built from Asana's API reference (`packages/testkit/src/mocks/asana.ts`). Like Asana, it returns only the fields `opt_fields` names, so the tests show a task's name and notes never come back. It answers 401 for the wrong token, filters tasks by project and `modified_since`, pages with `offset`, and can answer 429 with `Retry-After` and 400 for an expired offset. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, make a free Asana workspace for testing only, add a project or two of synthetic tasks, make a personal access token as a user who belongs only to that workspace, and add it as the `SANDBOX_ASANA_ACCESS_TOKEN` GitHub Actions secret.

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

### Avalara AvaTax

Reads AvaTax's REST API v2 (`https://rest.avatax.com`, or `https://sandbox-rest.avatax.com` for a sandbox account) with the account ID and license key as HTTP Basic credentials, sending `X-Avalara-Client` as AvaTax asks.

| Setting | What it is |
| --- | --- |
| `AVALARA_ACCOUNT_ID` | The AvaTax account number |
| `AVALARA_LICENSE_KEY` | The account's license key |
| `AVALARA_ENVIRONMENT` | `production` or `sandbox`, with no default |
| `AVALARA_COMPANY_CODE` | Optional. The company to read; empty means the account's default company |
| `CUSTOMER_REF_KEY` | Generated. Keys the customer references (below); the same key custom forms and Klaviyo use |

**Read-only.** An AvaTax license key can't be limited: it can do anything the account can, including recording, committing and voiding transactions. So the client is the guard. It sends only three GETs, `/api/v2/utilities/ping`, `/api/v2/companies` and `/api/v2/companies/{companyCode}/transactions`, to the fixed host for the environment. Every `$filter` is built from checked values (a day, a whole id or a UTC time, and a company code of letters, digits and `_.-`), so nothing read from settings or replies can change a query, and pages are asked for by the connector's own filter, never by following `@nextLink`. Ping must say the credentials were accepted and belong to `AVALARA_ACCOUNT_ID` before anything else is read. Recording, committing, voiding, adjusting and refunding transactions are declared behind the write gate, and the test shows each one is stopped.

**What it reads.** The first import reads every transaction dated in the last five years, by id, 1,000 a page, with `$include=SummaryOnly`, so the jurisdiction summary comes back without lines, per-line details or addresses. Each page is one batch, and the checkpoint records the last id read, so a resumed import carries on. Each later sync reads the transactions changed since the last pass started, less five minutes for changes still being saved (`modifiedDate ge`, in order of change and then id). The checkpoint records the change time it read up to and how many transactions it read at that time, so a pass that stops part way resumes without skipping or repeating one. With no checkpoint, the first pass looks back seven days. AvaTax requires a date range when listing transactions and otherwise looks only at the last 30 days, so every query also carries `date ge` the start of the history window. A 429 or 503 is waited out for `Retry-After` seconds, up to a minute, three times, then left to `runSync`, which retries from the checkpoint. A 401, or a Ping that says the credentials were turned down, stops the sync with a message saying what to check.

**Events.** Each transaction read becomes a `tax.transaction_updated` event keyed by the transaction id and a digest of what was kept, so reading it again unchanged is a duplicate and a commit, void or adjustment is a new event. It carries the document code, kind (sale, return, purchase, transfer, reverse charge or customs), AvaTax's document type and status, the day and tax day, the currency, the total, taxable, exempt and tax amounts in cents, the region, country and location code, the exemption reason code and whether a certificate was given, any tax override or adjustment reason, the version, whether it is reconciled or locked, and each jurisdiction in the summary with its type, code, name, tax type and name, rate, and taxable, tax, non-taxable and exempt amounts in cents. A transaction whose id, day, change time, type, status or total tax doesn't read is dead-lettered listing what was wrong.

**Privacy.** The customer and vendor names, email addresses, addresses, exemption certificate numbers, business and VAT numbers, purchase order numbers, descriptions, salesperson codes and line items are never kept. The customer code becomes a reference, an HMAC-SHA256 keyed with `CUSTOMER_REF_KEY` over the account, company and code, so a customer's transactions link to each other. When a transaction carries an email address, it also gets contact references made exactly the way custom forms makes them, so it links to the same person's form submissions and Klaviyo profile.

**Webhooks.** None: AvaTax has no webhooks for transactions, so the scheduled sync polls.

**Testing.** The tests run against a mock built from Avalara's API reference (`packages/testkit/src/mocks/avalara.ts`). It answers 401 for the wrong credentials, applies the documented 30-day default when no date filter is sent, reads the filters and orderings the connector sends and answers 400 to any other, and can answer 429 with `Retry-After`. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, sign up for a free AvaTax sandbox account, create a test company, record a few synthetic committed sales, generate a license key, and add `SANDBOX_AVALARA_ACCOUNT_ID` and `SANDBOX_AVALARA_LICENSE_KEY` as GitHub Actions secrets.

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

### e-Jewelry for Business Central

Reads a jeweler's e-Jewelry, which runs on Microsoft Dynamics 365 Business Central: items, vendors, sales invoices and purchase invoices, so finance, buying and inventory see the ERP next to retail and memo. Books arrive in the same `accounting.*` events the NetSuite, QuickBooks and Xero connectors give.

| Setting | What it is |
| --- | --- |
| `EJEWELRY_TENANT_ID` | The Microsoft Entra tenant id of the jeweler's Business Central |
| `EJEWELRY_ENVIRONMENT` | The Business Central environment's name, such as `production` |
| `EJEWELRY_COMPANY_ID` | The id of the company e-Jewelry's data is in |
| `EJEWELRY_CLIENT_ID` | The client id of the Microsoft Entra app registered for KaratOS |
| `EJEWELRY_CLIENT_SECRET` | A client secret of that app |

**Read-only by design.** The connector signs in service to service: it trades the app's client id and secret for a token (client credentials, scope `https://api.businesscentral.dynamics.com/.default`). Microsoft Entra has no read-only permission for Business Central, so what the app can do is set by the permission sets it is given on Business Central's Microsoft Entra Applications page, and the setup asks for read-only ones, never SUPER. The client sends only the token request and GETs of four lists in the one company, each marked `Data-Access-Intent: ReadOnly`, and follows a next link only while it stays on the list being read. Creating a draft sales quote and updating an item are declared behind the write gate, each needing approval, turned off, and the client has no request to send them.

**What it reads.** The first import reads every item and vendor, then the sales and purchase invoices changed in the last five years. Each later sync reads what changed since the newest change the last one saw, less ten minutes; the first later sync looks back three days. Business Central pages each list itself, and each page is one batch. The checkpoint keeps the list, its start, the next link and the newest change seen. A row read again unchanged is a duplicate.

**Events.**
- `accounting.item_updated` for each item: its number as the sku, name, kind, category, whether it is active, unit price and cost in whole cents, units on hand and unit.
- `accounting.vendor_updated` for each vendor: its number, name, currency, what is owed to it and whether it is active (not blocked).
- `accounting.invoice_updated` for each sales invoice: its number, the customer's Business Central id, dates, total, tax and what is still owed, currency and status.
- `accounting.bill_updated` for each purchase invoice: its number, the vendor's id and invoice number, dates, total, tax, currency and status.

Each event is dated when the row last changed, which Business Central writes in UTC. A blank currency is the company's own. A row without an id or a change time, or an item of another kind, is dead-lettered.

**Privacy.** A sales invoice's customer is kept as Business Central's id only: never the name, address, email or phone the invoice carries.

**Not yet.** Memos, jobs and diamond records are e-Jewelry's own pages and tables. e-Jewelry doesn't publish an API for them, so they wait for the first client's tenant to show what it exposes.

**Rate limits.** Business Central allows 6,000 calls in five minutes for a user, so calls are spaced a tenth of a second apart. A 429, 500, 502, 503 or 504 is waited out as `Retry-After` says (up to a minute), or 5, 10 and 20 seconds, before the error goes to the sync runner, which resumes from its checkpoint. A 400 or 401 on sign-in says the client id, secret or tenant is wrong; a 403 on a list says the app's permission sets don't cover it; a 404 says the environment or company is wrong. A token turned down mid-sync is replaced once.

**Testing.** The tests run against a mock built from Business Central's API reference and Microsoft's service-to-service guide (`packages/testkit/src/mocks/bci_e_jewelry.ts`). It checks the sign-in form and scope, the token, the tenant, environment and company in each path, the filter, and that next links keep it. The first client's tenant must confirm that e-Jewelry keeps its items, vendors and invoices in Business Central's standard tables, and how a next link is written.

### BigCommerce

Reads the BigCommerce REST Management API at `https://api.bigcommerce.com/stores/<store hash>/`, signed in with a store-level API account's token in `X-Auth-Token`. BigCommerce documents no way to read which OAuth scopes a token holds (scopes are fixed when the account is created and no endpoint reports them), so the connector can't check them at run time the way the Square connector does. Read-only is enforced in the client instead: it sends GET requests only, to nine listed paths, each with its own query parameters, and anything else is stopped before it leaves the server: `GET /v2/store`, `/v2/orders`, `/v2/orders/{id}/products`, `/v3/orders/{id}/payment_actions/refunds`, `/v3/catalog/products`, `/v3/inventory/items`, `/v3/customers`, `/v3/pricelists` and `/v3/pricelists/{id}/records`. Before its first read it asks for the store's information and stops unless the store hash it reports is `BIGCOMMERCE_STORE_HASH`, so a token for another store is caught at once. The writes it may do later (set inventory, set a price list price) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `BIGCOMMERCE_STORE_HASH` | The store hash from the API path |
| `BIGCOMMERCE_ACCESS_TOKEN` | The store-level API account's access token (scopes below) |
| `CUSTOMER_REF_KEY` | Keys the customer references (below). Generated by `npm run secrets:setup`; never rotated |
| `BIGCOMMERCE_WEBHOOK_SECRET` | Optional. The shared secret sent as a custom header on each webhook, for when webhooks are turned on. Generated by `npm run secrets:setup` |

**Scopes.** Create the API account (Settings > Store-level API accounts, V2/V3 API token) with these read-only and every other scope at None: Orders (`store_v2_orders_read_only`), Products (`store_v2_products_read_only`, which also covers price lists), Customers (`store_v2_customers_read_only`), Information & settings (`store_v2_information_read_only`) and Store inventory (`store_inventory_read_only`). Order refunds are read with the Orders scope. BigCommerce can't change an account's scopes later; a new account is needed.

**What it reads.** In order: products with their variants, the stock at every location, customers, orders with their lines and refunds, the B2B price lists, and each list's prices with their SKUs and quantity tiers. The historical import reads everything changed in the last five years; incremental passes read what changed since the previous pass started, less five minutes; with no checkpoint the first pass looks back 48 hours. Products, customers and orders are read oldest change first (`date_modified:min` on v3, `min_date_modified` on v2) and paged by change time: each page starts at the time the previous one ended on and skips the records already read at that time, so a record changed mid-pass moves to the end instead of making another be skipped. Orders come 50 a page, and each order's lines are read in full; its refunds are read when it has a refunded amount or a refunded status. Inventory, price lists and price list records have no change-time sort and are paged by number (`meta.pagination`). The checkpoint keeps the stream, the page, the change time and the price list being read, so a crash resumes at the next page.

**Events.** The same types and shapes as the connectors already built. Orders give `order.updated` (Shopify's shape), `sale.completed` once paid (statuses Shipped, Partially Shipped, Awaiting Pickup, Awaiting Shipment, Awaiting Fulfillment, Completed, Refunded and Partially Refunded), with the store's payment method mapped to card, cash, check, gift card, financing, wire or other, and `sale.returned` for each refund with product lines, by the SKUs of the refunded lines. Products give `product.updated` (Shopify's shape), with each variant's SKU, price and stock. Inventory gives `inventory.counted` per variant and location (the POS connector's shape); BigCommerce reports no count time, so a count is dated at the pass that read it and stored once a day unless it changes. Customers give `customer.profile_updated` with marketing consent off, since the customer record doesn't say whether they agreed to email marketing. No department owns a price list event yet, so price lists give the neutral `price_list.updated` (name and whether active) and `price_list.price_updated` (a variant's price, sale, retail and MAP prices in one currency, with its quantity tiers), for a wholesale department to read later. Each event is keyed by record and change time (a sale by its order alone), so a replay is a duplicate.

**Privacy.** A customer becomes `bigcommerce:customer:<hmac>`, an HMAC-SHA256 of the store hash and customer ID keyed with `CUSTOMER_REF_KEY`, the key custom form submissions and the Square and Clover connectors use; a guest checkout has none. No names, email addresses, phone numbers, addresses, company names, IP addresses, customer messages, staff notes, product options or coupon codes are kept.

**Rate limits.** Every response carries `X-Rate-Limit-Requests-Left` and `X-Rate-Limit-Time-Reset-Ms`. When none are left the client waits out the reset (up to a minute) before the next request. On 429 it waits the reset, or backs off 1, 2 and 4 seconds when the header is missing, then hands the error to `runSync`, and the next run resumes from the checkpoint.

**Webhooks.** Webhooks created with a store-level API account carry no signature, so each one is created with a custom header, `x-karatos-webhook-secret`, holding `BIGCOMMERCE_WEBHOOK_SECRET`, and `verifyBigCommerceWebhook` compares it in constant time (both sides hashed first, so neither content nor length leaks). A notification names the scope and record ID, not the record, so it only prompts a sync: `bigCommerceWebhookChange` reads the change for this store (by `producer`) and drops one sent more than 49 hours ago, just past BigCommerce's 48 hours of retries, and `BigCommerceWebhookDeduper` takes each `hash` (the same on every delivery of an event) once. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** Until a BigCommerce sandbox store is set up, the tests run against a mock built from BigCommerce's docs (`packages/testkit/src/mocks/bigcommerce.ts`), which answers 401 without the store's token, serves v2 times in RFC 2822 and empty v2 pages as 204, returns variants and record SKUs only when asked, sends the rate-limit headers and queued 429s, and enforces the documented filters, sorts and page limits. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, create a free BigCommerce sandbox store (a trial store, or a sandbox from the partner program), create a store-level API account in it with the read-only scopes above, and add `SANDBOX_BIGCOMMERCE_STORE_HASH` and `SANDBOX_BIGCOMMERCE_ACCESS_TOKEN` as GitHub Actions secrets. The token doesn't expire, so the run keeps working.

### BILL

Reads a business's supplier bills, their approvals, the vendors it pays and the payments it sends from BILL's v3 API, for the finance and buying departments.

| Setting | What it is |
| --- | --- |
| `BILL_CLIENT_ID` | The client id of a BILL developer app made with accounting data access |
| `BILL_CLIENT_SECRET` | That app's client secret |
| `BILL_ENVIRONMENT` | Optional. `production` (the default) or `sandbox` |

**Sign-in.** BILL's developer apps offer two choices: full access, which can create payments and change funding accounts, and accounting data access, which can't. There is no read-only option, so the app is made with accounting data access and the connector itself only ever reads. The client signs in with OAuth client credentials at `POST /authx/token` (`auth.bill.com`, or `auth.stage.bill.com` for the sandbox), keeps the token until five minutes before its hour runs out, and sends it as a bearer token, with no developer key or session id. A 401 signs in again once.

**What it reads.** `GET /v3/vendors`, `/v3/bills` and `/v3/payments`, in that order, 100 to a page, filtered to records changed at or after the pass's start and sorted by `updatedTime`, oldest first. The checkpoint keeps the list and BILL's page token, so a resumed sync goes on from the page it reached. The historical import reads six years; each later sync asks from the start of the last one, less five minutes, and the overlap comes back as duplicates. BILL allows 3 requests at once for an organization (`BDC_1322`, retried with backoff, as are 429 and 503) and 20,000 an hour (`BDC_1144`, which stops the sync until the next one).

**Events.** The same types the QuickBooks and Xero connectors give:

- `accounting.vendor_updated`: the vendor id, name, whether it's archived, its bill currency and how BILL pays it (ACH, check and so on).
- `accounting.bill_updated`: the bill id, vendor, invoice number and date, due date, total, balance due, amount paid and scheduled in cents, currency, payment status and approval status, and whether it's archived.
- `accounting.payment_updated`: the payment id, vendor, process date, amount in cents and in US dollars, status, method, whether it was made in BILL, and the bills it paid with how much each.

Each is keyed by record, id and `updatedTime`, so each change is stored once. A record with no readable id or time is dead-lettered. Vendor email addresses, phone numbers, street addresses, account numbers, tax ids and bank details, payment card digits, check numbers and confirmation numbers, and bill and payment descriptions are never kept.

**Writes.** None. KaratOS never pays, approves, voids or changes anything in BILL. BILL doesn't send webhooks to apps that sign in this way, so the connector reads on each sync.

**Testing.** The mock (`packages/testkit/src/mocks/bill_com.ts`) is built from BILL's developer docs, and its assumptions list what the first live run must confirm: rate-limit errors as HTTP 400, the filter's time format, and page tokens sent with the first page's filters. The nightly sandbox run signs in at BILL's sandbox and reads a year of records once `SANDBOX_BILL_COM_CLIENT_ID` and `SANDBOX_BILL_COM_CLIENT_SECRET` are set.

### Birdeye

Reads one Birdeye business's reviews: the ones Birdeye gathers from Google, Facebook, Yelp and the other sites it watches, and its own direct feedback. They arrive as the same `review.updated` events the Yext connector gives, so marketing and clienteling read reviews from either the same way.

| Setting | What it is |
| --- | --- |
| `BIRDEYE_API_KEY` | The business's Birdeye API key, from the Birdeye dashboard |
| `BIRDEYE_BUSINESS_ID` | The numeric id of the business (location) to read |

**Read-only by design.** Birdeye issues one kind of key and its docs describe no way to limit it to reading, so the same key could reply to reviews. The client is what keeps KaratOS to reading: its only request is Get Reviews (`POST /resources/v1/review/businessId/{id}`, a search sent as a POST) with a body it builds itself. Replying to a review is declared behind the write gate, turned off, and the client has no request to send it.

**What it reads.** The first import reads reviews posted in the last five years (`fromDate`), published and parked alike, 100 a page. Each sync after reads reviews changed since the day the last pass started, less a day (`updateFromDate`), as Birdeye filters by whole days. A page shorter than 100 ends the pass. The checkpoint keeps the offset, so a resumed sync goes on from the page it reached. Birdeye won't page past 100,000 reviews in one read.

**Events.** `review.updated` for each review, with the business, the site it came from, its rating (0 to 5; Birdeye gives 0 for direct feedback and Facebook recommendations), the title and an excerpt, whether it was edited, when it was posted and answered, a link to it, and whether it is still awaiting a reply. Each is keyed by a digest of what was kept, so an edited or newly answered review is stored as a new version and an unchanged one is a duplicate. A review with no readable date is dead-lettered.

**Privacy.** A review is written by a customer, so no reviewer name, nickname, photo or Birdeye customer id is kept, nor the custom fields or the staff named on it. The title and excerpt (the first 500 characters) have email addresses and phone numbers masked. The store's reply is noted, not copied, and a link keeps its address without the query string.

**Rate limits.** Birdeye sets a call limit per key and answers 429 (code 89) past it. The client waits out a 429, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 means the key is wrong, and a 404 that the business id is.

**Testing.** Birdeye has no sandbox. The tests run against a mock built from Birdeye's API docs (`packages/testkit/src/mocks/birdeye.ts`), which checks the key header, the business, the page window and the date format, and lists what the first client's key must confirm: that reviews come oldest first, and that `updateFromDate` includes new reviews.

### Calendly

Reads Calendly's API v2 (`https://api.calendly.com`) with a personal access token: the signed-in user, the organization's scheduled events and each event's invitees. Each invitee of an event is one appointment.

| Setting | What it is |
| --- | --- |
| `CALENDLY_ACCESS_TOKEN` | A personal access token with only the `users:read` and `scheduled_events:read` scopes, made by an owner or admin so it can read every team member's appointments |
| `CUSTOMER_REF_KEY` | Generated. Keys the customer references (below); the same key custom forms and Klaviyo use |

**Read-only.** The client sends only three GETs: `/users/me`, `/scheduled_events` and `/scheduled_events/{uuid}/invitees`, with parameters it builds itself. Event ids and page tokens are checked before they go into a request, and the next page is asked for by its `page_token`, never by following the `next_page` link, so a reply can't send the token to another host. Calendly has no way to ask which scopes a token holds, so give it the two read scopes only. Booking, cancelling and marking a no-show are declared behind the write gate, and the test shows each one is stopped.

**What it reads.** The first import reads every event starting from two years ago to a year ahead, earliest first, 100 a page. Each batch's checkpoint records the start time it read up to, so a resumed import carries on just before it. Calendly lists events by start time, not by when they changed, so each later sync reads events from 30 days ago to a year ahead, the span where bookings are moved, cancelled and marked no-shows. An event's invitees are read again only when the event changed since the last sync (the checkpoint keeps a short hash of each recent event) or it started in the last 14 days, when no-shows are marked. That keeps a free plan's 50 requests a minute enough for a busy store. When the token's owner isn't an owner or admin, Calendly answers 403 to the organization's events and the connector reads the owner's own instead. A 429 is waited out for `X-RateLimit-Reset` seconds, up to a minute, three times, then left to `runSync`, which retries from the checkpoint. A 401 or a 403 naming missing scopes stops the sync with a message saying what to fix.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `appointment.booked` | An active invitee | invitee and a digest of what was read |
| `appointment.canceled` | A cancelled invitee, with when and whether the host or invitee cancelled | invitee and digest |
| `appointment.no_show` | An invitee marked a no-show | invitee and digest |

Each one carries the appointment's kind (bridal, custom design, repair, appraisal, pickup, consultation or other, read from the event's title), its start, end and length, the kind of place (in person, phone, video, custom or ask the invitee), the hosts as `calendly:user:<id>`, how many guests and answered questions, when it was booked and whether staff booked it, links to the booking it replaced or was replaced by when rescheduled, a payment's provider, amount in cents and currency, and the UTM source, medium and campaign it came from. A booking read again unchanged is a duplicate. An invitee or event whose id, times or status don't read is dead-lettered listing what was wrong.

**Privacy.** Names, email addresses, phone numbers, guests' addresses, answers to the booking questions, meeting notes, cancellation reasons, cancel and reschedule links and where the meeting is held are never kept. The invitee's email address and text reminder number are used only to make customer references, made exactly the way custom forms makes them, so a booking, a form submission and a Klaviyo profile from the same address name the same customer. The event title is kept only when it doesn't hold any word of the invitee's name or email address, since one-off meetings are often named after the person.

**Webhooks.** None. Calendly's webhook subscriptions need a paid plan and the `webhooks:write` scope, which a read-only token shouldn't hold, so the scheduled sync polls.

**Testing.** The tests run against a mock built from Calendly's API reference (`packages/testkit/src/mocks/calendly.ts`). It answers 401 for the wrong token, 403 when a member who isn't an admin lists the organization, filters and sorts by start time, pages with `page_token`, and can answer 429 with the rate limit headers. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, create a free Calendly account for testing only, book a few appointments with synthetic invitees (`@example.test` addresses), make a personal access token with the two read scopes, and add it as the `SANDBOX_CALENDLY_ACCESS_TOKEN` GitHub Actions secret.

### Chase

Chase business checking, savings and credit cards, from the CSV activity downloads in Chase's online banking, the monthly PDF statements, or both. It is the bank and credit card statements connector with Chase's own profiles built in, synced under its own source, `chase`, so no profile file is needed.

| Setting | What it is |
| --- | --- |
| `CHASE_IMPORT_MODE` | `manual_csv`, `manual_pdf` or `manual_csv_and_pdf`: which files in the folders to read. Anything else stops the sync with an error naming the three choices |
| `CHASE_MANUAL_IMPORT_DIR` | The folder of downloads, outside any git repo, with one subfolder per account like `checking-1234`, `savings-2345` or `card-5678`. Card and credit folders are read with the card profile, and the rest with the checking profile |

**What the profiles know.** For checking and savings, the CSV columns are Details, Posting Date, Description, Amount, Type, Balance and Check or Slip #, and the trailing comma Chase puts on every row is ignored. The PDF period line reads "December 16, 2025 through January 15, 2026", and lines under CHECKS PAID start with the check number, sometimes with a `^` or `*` mark, then the date paid. Those become `CHECK 1001` with the check number kept. For cards, the CSV columns are Transaction Date, Description and Amount, where purchases are negative and payments positive. The PDF closing date comes from "Opening/Closing Date 12/16/25 - 01/15/26", and charges sit under PURCHASE. Both profiles are also available to the generic connector by name in `BANK_STATEMENTS_PROFILES`.

The profiles were written from Chase's published download format and statement layout. Before sign-off, check them against one of the client's own statements and confirm the event count matches the statement's transaction count.

**Testing.** `packages/connectors/test/chase.test.ts` writes a synthetic two-page checking statement, a card statement and matching CSV downloads. It checks that each format reads the same transactions with the same keys, that each import mode reads only its own files, and that account folders get the right profile. No real statement goes in a repo.

### Cin7 Core

Reads the brand's Cin7 Core products, customers, suppliers, sales, purchases and stock at each location, so wholesale, buying and inventory see the stock Cin7 Core runs next to retail and marketplace sales.

| Setting | What it is |
| --- | --- |
| `CIN7_ACCOUNT_ID` | The Cin7 Core account id shown with the API application |
| `CIN7_APPLICATION_KEY` | The key of the API application made for KaratOS |

**Read-only by design.** Cin7 Core signs a call in by the account id and an API application's key, and its docs describe no way to limit what an application can do: the key could also change stock and post orders. So the client is what keeps KaratOS to reading: it sends only GETs of six lists to `https://inventory.dearsystems.com/ExternalApi/v2`, with parameters it builds itself from checked values. Use a separate API application for KaratOS, so it can be deleted without touching any other integration. Adjusting stock and creating a purchase order are declared behind the write gate, each needing approval, turned off, and the client has no request to send them.

**What it reads.** Cin7 Core filters products, customers and suppliers by when they were modified and sales and purchases by when they were updated, pages by number up to 1,000 at a time, and doesn't say what order a page comes in. So a pass reads a list from a time to its end, and the next sync starts from when that pass began, less ten minutes: a record that changed while the pass was reading is read again then. The first import reads every product, customer and supplier (deprecated ones too), the sales and purchases updated in the last five years, and the stock. Each later sync reads what changed since the last pass of each list began, less ten minutes, and the stock whole; the first later sync looks back three days. A record read again unchanged is a duplicate. Each page is one batch, and the checkpoint keeps the list, its start, the next page and when the pass began, so a resumed sync goes on from that page.

**Events.**
- `product.updated` for each product: its sku, name, category, brand, kind, unit, first price tier and average cost in cents, and whether it is active.
- `customer.profile_updated` for each customer and `accounting.vendor_updated` for each supplier: the name, currency and whether they are active.
- `order.updated` for each sale and `accounting.purchase_order_updated` for each purchase: the order and invoice numbers, the customer or supplier, the status, the order, invoice, due and required-by dates, the total, what is paid and what is still owed in cents, and the currency.
- `inventory.counted` for each product at each location, and each bin and batch where Cin7 Core splits stock by them: on hand, allocated, available and on order.

Cin7 Core writes times in UTC, so a record's event is dated by its change time and a stock count by when it was read. Each event is keyed by a digest of what was kept. A record without an id or a change time, a product without a sku, or stock whose on hand isn't a whole count, is dead-lettered.

**Privacy.** Customers' and suppliers' addresses, contacts, phone numbers and email addresses, and comments, are never read into an event.

**Rate limits.** Cin7 Core allows 60 calls a minute for each API application and answers 503 past that, so the client spaces its calls a second apart. It waits as `Retry-After` says (up to a minute), or 5, 10 and 20 seconds, on a 429, 500, 502, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 or 403 says the account id or key is wrong, or the application was deleted.

**Testing.** Cin7 Core needs a paid account or a trial. The tests run against a mock built from Cin7 Core's help center articles on its API (`packages/testkit/src/mocks/cin7.ts`). It checks both headers, the parameters each list takes, the change filters, deprecated records and the paging. It lists what the first client's account must confirm: the key each list's rows come under, the sale list's id fields, the time format, the shape of the account id and key, and that amounts are in the currency's units.

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

### Docusign

Reads Docusign's eSignature REST API (`/restapi/v2.1`) for one account: its envelopes, each with its recipients, so a store can see that every consignment and memo agreement is signed and chase the ones that aren't. It signs in with JWT Grant, as a server does, so nobody has to sign in again.

| Setting | What it is |
| --- | --- |
| `DOCUSIGN_INTEGRATION_KEY` | The integration key of the KaratOS app in Settings > Apps and Keys |
| `DOCUSIGN_PRIVATE_KEY` | The app's RSA private key, as Docusign shows it or base64-encoded on one line. It only signs the sign-in and is sent nowhere |
| `DOCUSIGN_USER_ID` | The API user id of the user the connector signs in as: one with the Viewer permission profile, which can't send, and shared access to the senders' envelopes |
| `DOCUSIGN_ACCOUNT_ID` | The API account id whose envelopes are read |
| `DOCUSIGN_ENVIRONMENT` | Optional. `production` (the default) or `developer` for a developer account |
| `DOCUSIGN_CONNECT_HMAC_KEYS` | Optional. The Connect configuration's HMAC keys, separated by commas, once Connect is turned on |
| `CUSTOMER_REF_KEY` | Keys the customer references made from recipients' email addresses |

**Connecting.** Add an app named KaratOS in Settings > Apps and Keys, generate its RSA key pair under Service Integration, and add one redirect URI for the consent step. Add a KaratOS user with the Viewer permission profile and give it shared access to the envelopes of each person who sends agreements. Then sign in once as that user at `https://account.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<integration key>&redirect_uri=<the redirect URI>` (`account-d.docusign.com` for a developer account) and accept, which gives the consent JWT Grant needs. Until then the sync stops saying the user hasn't consented.

**Read-only.** Docusign has no read-only scope: JWT Grant asks for `signature impersonation`, which every eSignature call needs, reads and sends alike. So it is the signed-in user that can't send, through its Viewer profile, and the client sends only three requests: the token request (`POST /oauth/token` on the sign-in host), `GET /oauth/userinfo` to find the account's API address, and `GET /accounts/{accountId}/envelopes`. The API address must be an https `docusign.net` address, and the account must be one the user belongs to. It never downloads a document. Sending an envelope is declared behind the write gate, and the test shows it is stopped.

**What it reads.** Each envelope's status, its kind, its created, sent, delivered, completed, declined, voided and deleted times, and each recipient's role, routing order, status and sent, delivered, signed and declined times. The kind (consignment, memo, appraisal, custom order, repair, purchase, sale, layaway, employment, confidentiality, vendor or other) is read from the email subject, which isn't kept, since it often names the customer. A recipient's email address only makes a keyed customer reference, the same one custom forms, Calendly and Klaviyo make, so a signed memo links to the same person's other records; the address isn't kept. Names, phone numbers, messages, decline reasons, field values and documents never are. At most 100 recipients are kept per envelope.

The first import reads envelopes whose status changed in the last five years, 100 a page, oldest change first. Each later sync asks only for envelopes changed since the last pass started, less five minutes of overlap, and then reads every envelope still out for signature, since a recipient viewing or signing doesn't always change the envelope's own status. Each batch's checkpoint keeps the latest status change read, so a resumed sync asks again from there and envelopes read twice are duplicates. Docusign asks apps to read an envelope at most once every 15 minutes, so don't schedule the sync more often than that. A token lasts an hour and a new one is asked for 15 minutes before it ends; a 401 signs in again once. A 429 is waited out for `Retry-After` seconds, up to a minute, three times, then left to `runSync`, which retries from the checkpoint.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `agreement.updated` | An envelope: `docusign:envelope:<id>`, its kind, status and times, how many must sign, how many have, how many are still to, and its recipients | envelope and a hash of what was read |

Each version is keyed by a hash of what was read, so a change is stored once and a replay is a duplicate. An envelope with no time that reads is dead-lettered.

**Webhooks.** Docusign Connect, in the JSON SIM format with the envelope summary and recipients included. `verifyDocusignConnect` checks the `X-Docusign-Signature-N` headers against the raw body with each of `DOCUSIGN_CONNECT_HMAC_KEYS`, in constant time, before the body is parsed. Docusign signs no timestamp, so a delivery generated more than a day ago, one for another account, or one whose summary doesn't match its envelope gives no events, and the event keys are the sync's own, so a replay stores nothing twice.

**Testing.** The tests run against a mock built from Docusign's developer docs (`packages/testkit/src/mocks/docusign.ts`). Its sign-in checks the JWT's RS256 signature against the app's public key and its claims, including the scope, and answers `consent_required` until the user consents. Its envelope list filters by status change and status, sorts, pages with `start_position`, writes counts as strings and leaves the list out when nothing matches, as Docusign does, and can answer 429. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, make a free Docusign developer account, send a few envelopes of synthetic agreements to test addresses, set up the app and a Viewer user as above, consent once, and add the `SANDBOX_DOCUSIGN_INTEGRATION_KEY`, `SANDBOX_DOCUSIGN_USER_ID`, `SANDBOX_DOCUSIGN_ACCOUNT_ID` and `SANDBOX_DOCUSIGN_PRIVATE_KEY` GitHub Actions secrets.

### Dropbox

Reads Dropbox's API (v2) for one folder the store chooses, and everything below it: its files and folders, then every change, so a department can see a new statement, invoice, appraisal or design file land without anyone moving it. The store approves a KaratOS app once and the connector keeps a refresh token, so nobody signs in again.

| Setting | What it is |
| --- | --- |
| `DROPBOX_APP_KEY` | The app key of the store's KaratOS app in the Dropbox App Console |
| `DROPBOX_APP_SECRET` | The app's secret. It goes with each token refresh and checks webhook signatures |
| `DROPBOX_REFRESH_TOKEN` | The refresh token from the account owner approving the app once with offline access |
| `DROPBOX_FOLDER` | The folder to read, as the Dropbox website shows its path, such as `/Accounting`. Not the whole Dropbox |
| `DROPBOX_FILE_NAMES` | Optional. `keep` (the default) keeps file and folder names; `drop` keeps only ids, kinds and times |

**Connecting.** In the App Console, create a Scoped access app with Full Dropbox access named KaratOS, and in its Permissions tab tick only `files.metadata.read` and `files.content.read` (`account_info.read` is always on). Signed in as the account owner, open `https://www.dropbox.com/oauth2/authorize?client_id=<app key>&response_type=code&token_access_type=offline&scope=files.metadata.read%20files.content.read`, choose Allow, and exchange the code it shows once at `POST https://api.dropboxapi.com/oauth2/token` with `grant_type=authorization_code` and the app key and secret, on the host. Save the answer's `refresh_token` straight into the host's secret store.

**Read-only.** Each token refresh asks Dropbox for `account_info.read` and `files.metadata.read` only (and `files.content.read` for file imports), so the token can't write whatever the app was given, and the client stops if Dropbox reports any other scope. It sends only the token refresh, `POST /2/users/get_current_account`, `POST /2/files/list_folder` and `POST /2/files/list_folder/continue`; Dropbox's RPC calls are POSTs, but these only read. File imports also send `POST /2/files/download`. Saving a report is declared behind the write gate, and the test shows it is stopped.

**What it reads.** For each file: its id, name, kind (pdf, spreadsheet, document, presentation, image, design or file) and extension, its modified times, size, revision and content hash, and whether Dropbox can download it. For each folder: its id and name. Paths aren't kept, since folder names often name customers: each file and its folder get a reference made from a hash of the lowercased path, so a deletion, which Dropbox reports by path only, links to the file that was there. Sharing, links and who made a change are never kept, and `DROPBOX_FILE_NAMES=drop` leaves names out too.

The historical import lists the folder and everything below it, 500 entries a page, keeping every folder and each file changed in the last five years. When the listing ends, its cursor becomes the change feed: each later sync asks only for what changed since, including edits, moves and deletions. The incremental sync keeps its own checkpoint, so its first run lists the folder once (what the import stored comes back as duplicates) and reads changes from then on. Each batch's checkpoint keeps Dropbox's cursor, so a resumed sync asks again from the page it was on. If Dropbox resets a cursor, the folder is listed again (at most three times a sync); a deletion in between can't be seen then. Every call names the account's root namespace in `Dropbox-API-Path-Root`, so in a team space the folder path is the one the website shows. A token lasts four hours and a new one is asked for five minutes before it ends; a 401 refreshes once. A 429 is waited out for `Retry-After` seconds, up to a minute, three times, then left to `runSync`.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `document.file_updated` | A file or folder: `dropbox:file:<id>`, its name, kind, path references and the details above | id and a hash of what was read |
| `document.file_removed` | A deleted or moved-away path: its path reference, name and `reason: removed` | path and the page it was read on |

These are the same events Google Drive gives. A file with no modified time that reads is dead-lettered. Folders and deletions carry no time of their own, so they take the time they were read.

**File imports.** `dropboxFileSource` gives the file imports (bank and refiner statements, supplier invoices and the rest) the files directly in one Dropbox folder, read through a client that also asks for `files.content.read`. It skips subfolders and files Dropbox can't download, won't read a file over 25 MB, and checks each download against Dropbox's content hash. Pointing each import's settings at a Dropbox folder is the next step.

**Webhooks.** Dropbox checks the webhook address with a GET carrying `?challenge=`, which `dropboxWebhookChallenge` echoes as plain text. Each notification's `X-Dropbox-Signature` is the hex HMAC-SHA256 of the raw body keyed with the app secret, checked by `verifyDropboxWebhook` in constant time before the body is parsed. A notification only lists the accounts with changes, so it carries no events: `webhookPromptsSync` says whether it names this account, and the incremental sync reads the change. A replay only prompts a sync that finds nothing new.

**Testing.** The tests run against a mock built from Dropbox's HTTP documentation and OAuth guide (`packages/testkit/src/mocks/dropbox.ts`). Its token refresh checks the app's key, secret and refresh token and gives a token with only the scopes asked for, which must be among the app's own. Every change goes into a log, so a listing cursor carries on with exactly what changed after it, deletions included; it can reset cursors, revoke tokens and answer 429. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, make a free Dropbox Basic account with a `/KaratOS Test` folder of synthetic statements and invoices, a scoped test app as above, approve it once, and add the `SANDBOX_DROPBOX_APP_KEY`, `SANDBOX_DROPBOX_APP_SECRET` and `SANDBOX_DROPBOX_REFRESH_TOKEN` GitHub Actions secrets.

### eBay

Reads one seller's eBay orders through the Fulfillment API (Sell APIs, v1). Read-only two ways over: every access token is asked for from the seller's refresh token with `sell.fulfillment.readonly` alone, so eBay itself turns down any change to an order or listing; and the only API request is getOrders, with a filter, page size and offset the client builds and checks itself.

| Setting | What it is |
| --- | --- |
| `EBAY_CLIENT_ID` | The App ID of an eBay developer app the store owns |
| `EBAY_CLIENT_SECRET` | The same keyset's Cert ID |
| `EBAY_REFRESH_TOKEN` | The seller account's refresh token, agreed with `sell.fulfillment.readonly` only. It lasts 18 months |
| `EBAY_ENVIRONMENT` | `production` (the default) or `sandbox` |

**What it reads.** Orders, 200 a page, a 31-day window at a time. The historical import reads every order created in the two years getOrders reaches, up to now. Each incremental sync reads the orders changed since the previous pass ended, less 15 minutes, so a shipped or refunded order comes in again as a new version. getOrders pages by offset, so each next page starts 20 orders early in case an order changed mid-read and shifted the rest.

**Events.** Every order gives `order.updated`, with its fulfillment and payment status, whether it was cancelled, its total and what eBay kept in fees, in cents. A paid order that isn't cancelled gives `sale.completed` with each line's SKU (or a stand-in from the listing), quantity, unit price and discount. A line refunded in full gives `sale.returned`; a partial refund moves no stock, so it shows in the order's `refundedCents` only. These are the same shapes as Shopify and BigCommerce.

**Privacy.** No buyer username, name, email address, phone number, shipping address or checkout note is kept, so no eBay user data is stored. That makes the store eligible for eBay's exemption from Marketplace Account Deletion notifications, which every production keyset must either subscribe to or opt out of.

**Rate limits.** eBay counts calls a day per app. The client sends one request at a time, waits out a 429 (honoring `Retry-After` up to a minute, doubling from a second otherwise), three tries, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 renews the access token once.

**Writes.** Setting a listing's quantity, so a piece sold in the store can't sell again online, setting a listing's price and adding tracking to an order are declared, so they can be gated and audited, and all three are turned off. Each needs a named person's approval. Turning them on would also need a refresh token with the write scopes, which the client never asks for today.

**Not read yet.** Listings and stock come from the Inventory API, which only covers listings made through that API, so a store that lists in Seller Hub needs them moved over first. That is a follow-up.

**Testing.** The tests run against a mock built from eBay's docs (`packages/testkit/src/mocks/ebay.ts`), which checks the client credentials, that a refresh asks only for scopes the seller agreed to, the token's scope on each call, the order filter, limit and offset. For the nightly run, make a sandbox keyset and a sandbox test user, get that user's refresh token with `sell.fulfillment.readonly` only, and add `SANDBOX_EBAY_CLIENT_ID`, `SANDBOX_EBAY_CLIENT_SECRET` and `SANDBOX_EBAY_REFRESH_TOKEN` as GitHub Actions secrets.

### EDI with retail partners

Reads the X12 files a wholesaler or manufacturer exchanges with its retail partners, from the folder where the business's VAN or SFTP mailbox keeps them. Partners send purchase orders, inventory and sell-through; the business sends acknowledgments, ship notices and invoices back, and the mailbox keeps a copy of each. KaratOS reads both sides of the folder and never sends a document, so there are no webhooks and nothing to write back.

| Setting | What it is |
| --- | --- |
| `EDI_IMPORT_DIR` | The folder the mailbox copies X12 files into, outside any git repo |

**What it reads.** Files ending in `.edi`, `.x12`, `.txt` or `.dat`, in name order. One file can hold several interchanges, each with its own delimiters, which are read from its fixed-width ISA segment. Each sync reads the files that are new or changed since the last one, with the same checkpoint as the other file-based connectors, so a crash resumes mid-file. Documents dated more than two years back are skipped. Interchanges marked as test (ISA15 `T`) are skipped, and so are transaction sets it doesn't read, such as 997 functional acknowledgments and 860 order changes.

**Events.**

| Set | Event | From the partner or the business | Date | Document number |
| --- | --- | --- | --- | --- |
| 850 | `edi.purchase_order_received` | Partner | BEG05 | BEG03 |
| 855 | `edi.purchase_order_acknowledged` | Business | BAK09, or BAK04 when there is none | BAK03 |
| 856 | `edi.shipment_noticed` | Business | BSN03 | BSN02 |
| 810 | `edi.invoice_sent` | Business | BIG01 | BIG02 |
| 846 | `edi.inventory_reported` | Partner | BIA04 | BIA03 |
| 852 | `edi.sell_through_reported` | Partner | XQ03 | XQ02 to XQ03 |

Every event carries `partnerId` (the qualifier and ID of the other side: the ISA sender for what partners send, the receiver for what the business sent) and `sourceDocument` (`file.edi:<ISA13>:<ST02>`). Lines carry the item number (VN, VA or VP first, then SK, BP or IN), the UPC (UP, UK or EN) when there is one, and every product ID pair as `ids`. Orders and invoices keep quantity, unit and unit price; ship notices keep each item under the order its HL loop belongs to, with carrier, bill of lading and tracking number; acknowledgments keep each line's ACK status (accepted, backordered, rejected and so on); 846 keeps each QTY code and quantity; 852 keeps each ZA activity code with store quantities from SDQ, added up when ZA leaves the total out. Prices read without floating point, half a cent rounded away from zero; SAC and TDS amounts use X12's two implied decimals.

The key is the partner, the set, the document number and a hash of the document's segments. The same order delivered again, even in a new file with new control numbers, is a duplicate; a changed order is a new event.

**When something doesn't add up.** An envelope whose IEA or GE count or control number is wrong, or a file cut off mid-interchange, stops the sync with the file and the problem named, since nothing in it can be trusted. A single document that can't be read (a wrong SE count, a missing PO number, a date that isn't CCYYMMDD, a quantity that isn't a number) is kept with its `problems` listed and no time, so the pipeline dead-letters just that document with the raw event kept.

**Writes.** Sending an 855, 856 or 810 is declared behind the write gate as `send_po_acknowledgment`, `send_ship_notice` and `send_invoice`, and the gate turns each one down while writes are off. Nothing sends them yet.

**What it leaves out.** Names and addresses in N1 to N4 are never stored: a ship-to store or reporting location is kept as its code only. No department reasons over these events yet; they are stored for the wholesale views to come.

**Testing.** The tests build synthetic interchanges in code, including other delimiters, several interchanges per file, every envelope error, and a broken document of each set.

### Etsy

Reads one Etsy shop through Etsy's Open API v3: its orders (receipts), with their sales and refunds, and its listings, in every state, with each product's price and stock. They arrive as the same events the eBay and Shopify connectors give, so an Etsy sale reads like any other.

| Setting | What it is |
| --- | --- |
| `ETSY_KEYSTRING` | The KaratOS app's keystring, also its OAuth client id |
| `ETSY_SHARED_SECRET` | The app's shared secret; with the keystring, it also encrypts the stored refresh token |
| `ETSY_REFRESH_TOKEN` | The refresh token from connecting the shop; it only seeds the stored one |
| `ETSY_SHOP_ID` | The numeric id of the shop to read |

**Sign-in.** The shop owner connects the app at `https://www.etsy.com/oauth/connect` (with PKCE) granting exactly `transactions_r listings_r`. Every request carries `x-api-key: <keystring>:<shared secret>`, and shop reads also a bearer token, which lasts an hour. The client refreshes at `POST https://api.etsy.com/v3/public/oauth/token`, saves whatever refresh token Etsy hands back before anything else, and runs one refresh at a time. Etsy's token answer doesn't list scopes, so after every refresh the client asks Etsy's token-scopes call (`POST /v3/application/scopes`) and stops if any scope isn't a read scope, if either read scope is missing, or if the answer can't be read. The first refresh also checks `GET /v3/application/users/me`, and the connector stops if the token belongs to a different shop than `ETSY_SHOP_ID`. A 401 refreshes once.

**What it reads.** Each pass reads `GET /v3/application/shops/{shop_id}/listings` with their inventory for each state (active, sold out, inactive, expired and draft), 100 at a time, then `GET /v3/application/shops/{shop_id}/receipts`, 100 at a time, oldest first. The first import reads receipts created in the last five years (`min_created`); each sync after reads receipts changed since the last pass started, less a quarter hour (`min_last_modified`). A page of receipts starts at the time the last page reached, using an offset only past receipts sharing that second, so a page never shifts as receipts change. The checkpoint keeps where the pass got to. Etsy limits calls per second and per rolling day; a 429 (or a 500, 502, 503 or 504) is waited out three times, honoring `Retry-After` up to a minute, before the sync stops and resumes from its checkpoint.

**Events.**

- `order.updated` for each version of a receipt: its status, whether it's paid, shipped or cancelled, the total with tax and shipping, the currency, what has been refunded, and its line count, with `marketplace: "etsy"`.
- `sale.completed` once a receipt is paid and not cancelled, keyed by receipt so a later change never counts it twice: each line's SKU (or a stand-in from the listing and product), quantity, unit price and shop discount, and how it was paid.
- `sale.returned` once a receipt is fully refunded, with each line's refund. A partial refund moves no stock, so it shows in the order's refunded amount only.
- `product.updated` for each listing with its products as variants: SKU, price and stock, and whether the listing is active, a draft or archived (inactive or expired).
- `inventory.counted` for each product's stock on Etsy, at the shop.

No buyer id, name, email address or shipping address is kept, nor gift or checkout messages, the seller's email, tracking codes, or listing descriptions, tags and materials.

**Writes.** Changing a listing's stock or price and marking an order shipped are declared behind the write gate and turned down while writes are off; no write scope is asked for.

**Testing.** Etsy has no sandbox. The mock (`packages/testkit/src/mocks/etsy.ts`) is built from Etsy's docs and its OpenAPI spec, and its assumptions list what the first live run on a developer's own shop must confirm, among them the token-scopes answer's shape and that a transaction's price is per item.

### FedEx tracking

Follows the FedEx packages on the business's list, such as repairs going out to a setter, memo goods and customer orders, through FedEx's free Track API. It shows where each is, flags a delivery exception as soon as FedEx records one, and says which parcels needed a signature.

| Setting | What it is |
| --- | --- |
| `FEDEX_CLIENT_ID` | The API key of a FedEx Developer Portal project with only the Track API chosen |
| `FEDEX_CLIENT_SECRET` | That project's secret key |
| `FEDEX_TRACKING_NUMBERS_FILE` | A text or CSV file of tracking numbers, one or more a line, split by spaces, commas or semicolons. Lines starting with `#` are skipped, and anything that isn't 12 to 34 digits or a door tag (DT and 12 digits) is left out |
| `FEDEX_ENVIRONMENT` | Optional. `production` (the default) or `test`, FedEx's sandbox |
| `FEDEX_MAX_TRACKING_PER_SYNC` | Optional. The most numbers one sync reads, 500 when unset |

**What it reads.** It works the way UPS tracking does, with the same shared tracking logic: each sync reads every number on the list that isn't delivered or returned yet, oldest first, 25 to a checkpoint, and a number that never gets there is dropped 120 days after it was first read.

The client signs in with the API key and secret (OAuth client credentials, sent as a form) and keeps the token until five minutes before it runs out. It calls `POST /track/v1/trackingnumbers` only, one number a call, with a fresh `x-customer-transaction-id` and no detailed scans. A 401 signs in again once; a 429 or 503 waits as Retry-After says, up to a minute, three times. A number FedEx has nothing for comes back as an error on its track result and is read again next sync.

**Events.** `shipment.tracked`, as for UPS: status from FedEx's derived code (or its code), FedEx's code and text, latest scan time in UTC, the estimated delivery day, the delivered day, the service, whether a direct, adult or indirect signature was asked for, and the destination's state and country. Days are the local day FedEx wrote. Names, street addresses, postal codes, who received or signed, declared values and proof-of-delivery images are never kept.

**Writes.** None. KaratOS never creates labels, pickups or returns, and doesn't make tracking subscriptions.

**Testing.** FedEx's request and response schemas sit behind a page this project can't read, so the mock (`packages/testkit/src/mocks/fedex.ts`) is built from FedEx's public catalog page and public sample responses, and its assumptions list what the first live run must confirm: the token form, the status codes and the not-found error. The nightly sandbox run signs in at FedEx's sandbox and reads two of its test numbers once `SANDBOX_FEDEX_CLIENT_ID` and `SANDBOX_FEDEX_CLIENT_SECRET` are set.

### FinCEN Form 8300 cash reporting

Reads the store's own Form 8300 filings log, kept as CSV in a folder, so the brain knows which cash sales are already reported, which filings FinCEN rejected, and which customers still need their written statement.

**Why a log.** A business that receives more than $10,000 in cash in one transaction, or in related transactions, files Form 8300 within 15 days through FinCEN's BSA E-Filing System. BSA E-Filing has no API, so filing stays with a person. The compliance department finds the cash sales that need a filing from the POS and bank data; the log tells it what has been filed since.

| Setting | What it is |
| --- | --- |
| `FINCEN_8300_IMPORT_DIR` | The folder holding the filings log, outside any git repo |
| `FINCEN_8300_DATE_ORDER` | Optional. `mdy` (the default), `dmy` or `ymd` |

**The log.** One row per filing, saved as CSV. Every CSV in the folder is read, so a store can keep one log or one per year. Start from this header row:

```text
Filed On,Cash Received On,Sale IDs,Customer ID,Cash Amount,BSA Tracking ID,BSA ID,Status,Statement Sent On,Suspicious
```

- **Required:** Filed On, Cash Received On (the date of the payment that took the total over $10,000), Sale IDs (the receipt numbers staff see, separated by commas, semicolons or spaces), and Cash Amount.
- **Optional:**
  - BSA Tracking ID, which BSA E-Filing shows on submission, and BSA ID, the 14-digit number it gives once the filing is accepted
  - Status: Submitted, Accepted, Accepted with Warnings or Rejected (blank is submitted)
  - Customer ID, the POS customer number
  - Statement Sent On, the day the customer was given their written statement
  - Suspicious: Yes for a filing made voluntarily for a suspicious transaction (box 1b)

Other names are read too, such as Date Filed, Transaction Date, Sale ID, Total Cash and Filing Status. **Never put names, addresses or taxpayer numbers in the log.** The connector reads only the columns above, so those stay on the form itself.

**Events.** Each row becomes `compliance.form_8300_filing_recorded` with the filing date, the date the cash was received, the sales, the cash in cents, the status, the days it took to file, and any BSA numbers, customer number, statement date and suspicious flag. A filing is named by its BSA ID, else its BSA Tracking ID, else its sales and the cash date. The key is `fincen_8300:filing:<filing>:<hash of what the row says>`, so the same log saved again stores a filing again only when something about it changed, such as a status moving to accepted. Keep the tracking ID on the row after adding the BSA ID so both versions read as one filing. Its time is the filing date.

A row with a problem (a missing or impossible date, filed before the cash came in, sales that aren't receipt numbers, an amount that isn't money, an unknown status, a BSA ID that isn't 14 digits, a tracking ID that isn't 6 to 20 digits, a suspicious flag that isn't yes or no) becomes an event with no time and a list of its problems, so the pipeline dead-letters it with the row kept. Filings older than five years are skipped; the IRS asks for copies to be kept for five years from the filing date. The checkpoint and resume work as for the POS connector: a file is read again only when its content changes.

**What the compliance department does with it.**

- The Form 8300 reminder for a cash sale stops once a filing in the log covers the sale. A receipt number in the log ("S-4015") matches the POS connector's full sale id ("pos:generic:sale:S-4015").
- If FinCEN rejects the filing, the reminder comes back, saying so, until a new filing is accepted or submitted. A later row for the same filing that still says submitted doesn't undo the rejection.
- Each person named on a required filing must get a written statement by January 31 of the year after the cash came in, giving the business's contact name, phone number and address, the total cash reported, and that it was reported to the IRS. The reminder runs from December 1 of that year until the statement date is in the log, and to the end of the next year at most. It never runs for a filing marked suspicious or for $10,000 or less, since a customer must not be told about a voluntary filing.

These are reminders for the owner, not legal advice.

**Testing.** Synthetic logs only: every status, a filing named by its BSA ID, its tracking ID and neither, a voluntary filing, unreadable rows, a blank line, day-first dates, and the same log saved again after FinCEN accepts a filing. The department tests cover a covered sale, a receipt number matched to the POS id, a rejection and the new filing after it, and the statement reminder across the year.

Rules come from the IRS [Instructions for Form 8300](https://www.irs.gov/instructions/i8300), which the docs watch follows.

### GIA Report Results

Looks up the GIA reports behind the certificate numbers the business holds, through GIA's Report Results API, and keeps them current. It confirms what each stone is before it is sold, insured or bought, and flags a number GIA has no report for.

| Setting | What it is |
| --- | --- |
| `GIA_API_URL` | The API address GIA gives at signup. Only https addresses on a gia.edu host are accepted, so the key can't be sent anywhere else |
| `GIA_API_KEY` | A Report Results API key, its own for KaratOS so it can be revoked alone |
| `GIA_REPORT_NUMBERS_FILE` | A text or CSV file of report numbers, one per line in the first column. Blank lines and lines starting with `#` are skipped; a line holding anything else stops the sync, naming the line but not its contents |
| `GIA_MAX_LOOKUPS_PER_SYNC` | Optional. The most new numbers one sync looks up, 100 when unset |

**What it reads.** Each sync looks up the numbers on the list it hasn't looked up yet, 25 to a checkpoint, then reads GIA's changed-reports feed from where it left off. A number is looked up once. GIA charges for lookups of reports the business didn't submit on a pay-as-you-go plan, while the feed is free and keeps every report this key has looked up current for two years, so updates come from the feed, never from a second lookup. A report at GIA for service is looked up again on a later sync. A used-up quota stops the sync with an error saying so; what was already looked up is kept.

The client sends two GraphQL queries only, `getReport` and `getChangedReports`, with variables it checked: a report number is 5 to 12 capital letters or digits. It never sends a mutation, so the changed-reports queue is read and never cleared. A 429 waits as Retry-After says, up to a minute, three times; a 403 says the key was denied without showing it.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `grading.report_retrieved` | A report found by lookup or in the changed-reports feed: report type, kind (natural or lab-grown diamond, pearl, identification, melee, narrative, jewelry or other), shape, measurements, carat weight as a number, color, clarity, cut, polish, symmetry, fluorescence, inscription, comments, origin, diamond type, proportions, which assets GIA has, and GIA's note on a reissued report | report number and a hash of the report, so an updated report is a new event and the same one read again is a duplicate |
| `grading.report_unavailable` | A number GIA has no report for (`not_found`), or won't show this key (`not_permitted`) | report number and reason, so it is recorded once |

A report's time is its report date; one without a readable date or number is dead-lettered with the raw event kept. Asset links are not stored, since GIA's last an hour; only which assets exist. No department reasons over these events yet.

**Writes.** None. Report results are GIA's to change.

**Testing.** The tests run against a mock built from GIA's developer docs (`packages/testkit/src/mocks/gia.ts`), with synthetic reports under GIA's published sandbox numbers. GIA's free plan includes a sandbox key; the nightly sandbox run looks up five sandbox reports once `SANDBOX_GIA_API_URL` and `SANDBOX_GIA_API_KEY` are set.

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

### Google Ads

Reads one Google Ads account's campaign figures by day through the Google Ads API (REST, v26). Google Ads has one OAuth scope, `adwords`, and it can change campaigns, so the scope can't keep the connection read-only. The client does: its only API request is `googleAds:search` for the account in the settings, with a query built from one fixed report, and it never calls a mutate method. Connect it as a Google Ads user with Read only access, so Google would turn down a change even if one were sent.

| Setting | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The instance's Google OAuth client, shared with the other Google connectors. Turn on the Google Ads API in its Cloud project |
| `GOOGLE_ADS_REFRESH_TOKEN` | A refresh token from a Google account with Read only access to the Google Ads account, granted `adwords` only |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | From a manager account's API Center. A new token reads test accounts only; a store's real account needs Basic access |
| `GOOGLE_ADS_CUSTOMER_ID` | The account's 10-digit customer id, with or without dashes |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Optional. The manager account's customer id, when the user reaches the store's account through one |

**What it reads.** One report, a 31-day window at a time, in Google's fixed pages of 10,000 rows: for each campaign and day, its status, channel and daily budget, and the impressions, clicks, cost, conversions and conversion value. The historical import reads two years up to today. Each incremental sync reads again from two weeks before the last day the previous pass read, since Google keeps attributing conversions to past clicks.

**Privacy.** The report is totals by campaign and day, so nothing names a person. Campaign names are cut short, and one holding an @ is dropped.

**Rate limits.** Google Ads meters each developer token in operations per day. The client sends one request at a time and waits out a 429 (`Retry-After` when sent, otherwise doubling from a second, three tries) before the error goes to the sync runner, which resumes from its checkpoint next time. A 403 means the connected user can't reach the account, or needs `GOOGLE_ADS_LOGIN_CUSTOMER_ID`; `DEVELOPER_TOKEN_NOT_APPROVED` means the token has test access only.

**Writes.** Pausing a campaign and changing its daily budget are declared, so they can be gated and audited, and both are turned off. Each needs a named person's approval and is capped at five a day. Turning them on would also need a user with Standard access in Google Ads.

**Events.** `ads.campaign_reported`, one per campaign and day, with the account's currency and time zone, and money in cents (Google gives cost and budget in micros). Each is keyed by its day, its campaign and a digest of its numbers, so a revised row is stored as a new version and an unchanged one is a duplicate.

**Testing.** The tests run against a mock built from Google's docs (`packages/testkit/src/mocks/google_ads.ts`), which checks the access token, the developer token, the scope, the account and manager headers, the GAQL fields, and that a page token belongs to its query, and counts any mutate call. For the nightly run, create a Google Ads test manager account with a test client account under it, connect a test Google account to a test OAuth client with `adwords`, and add `SANDBOX_GOOGLE_ADS_CLIENT_ID`, `SANDBOX_GOOGLE_ADS_CLIENT_SECRET`, `SANDBOX_GOOGLE_ADS_REFRESH_TOKEN`, `SANDBOX_GOOGLE_ADS_DEVELOPER_TOKEN`, `SANDBOX_GOOGLE_ADS_CUSTOMER_ID` and `SANDBOX_GOOGLE_ADS_LOGIN_CUSTOMER_ID` as GitHub Actions secrets. Any developer token reads test accounts.

### Google Analytics 4

Reads one GA4 property's reports through the Google Analytics Data API (v1beta). Read-only three ways over: the connection holds `analytics.readonly` and nothing else, which the client checks on every new access token; the only API request it sends is `runReport` for the property in the settings, with a body built from two fixed reports; and the Admin API is never called. Analytics has nothing to write, so no write is declared.

| Setting | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The instance's Google OAuth client, shared with Gmail and Google Workspace. Turn on the Google Analytics Data API in its Cloud project |
| `GOOGLE_ANALYTICS_REFRESH_TOKEN` | A refresh token from a Google account with Viewer access to the property, granted `analytics.readonly` only |
| `GOOGLE_ANALYTICS_PROPERTY_ID` | The property's numeric id from Admin > Property details (not the `G-` measurement id) |

**What it reads.** Two reports, a 31-day window at a time, 10,000 rows a page, sorted on every dimension so paging is stable:

- Traffic: by day, default channel group and source / medium, the sessions, total users, new users, engaged sessions, key events (GA4's conversions), ecommerce purchases and total revenue.
- Products: by day and item, the items viewed, added to cart and purchased, and item revenue.

The historical import reads two years up to today. Each incremental sync reads again from three days before the last day the previous pass read, since GA4 keeps adding late hits to recent days.

**Privacy.** Reports are totals by day, so nothing names a visitor. Source, medium and item names are cut short, and one holding an @ is dropped in case a campaign tag carried an email address. When GA4 withholds small rows (thresholding), the events say so.

**Rate limits.** The Data API meters each property in tokens per hour and per day. The client sends one request at a time and waits out a 429 (`Retry-After` when sent, otherwise doubling from a second, three tries) before the error goes to the sync runner, which resumes from its checkpoint next time. A 403 means the connected account can't read the property.

**Events.** `analytics.traffic_reported` and `analytics.product_views_reported`, one per row, with the day, the property's currency and time zone, and money in cents. Each is keyed by its day, its dimensions and a digest of its numbers, so a revised row is stored as a new version and an unchanged one is a duplicate.

**Testing.** The tests run against a mock built from Google's docs (`packages/testkit/src/mocks/google_analytics.ts`), which checks the token's scopes, the property, the date range, that item-scoped and session-scoped fields aren't mixed, and pages and sorts. For the nightly run, give a test Google account Viewer access to Google's public GA4 demo account (the Google Merchandise Store), connect it to a test OAuth client with `analytics.readonly`, and add `SANDBOX_GOOGLE_ANALYTICS_CLIENT_ID`, `SANDBOX_GOOGLE_ANALYTICS_CLIENT_SECRET`, `SANDBOX_GOOGLE_ANALYTICS_REFRESH_TOKEN` and `SANDBOX_GOOGLE_ANALYTICS_PROPERTY_ID` as GitHub Actions secrets.

### Google Business Profile

Reads a store's Google Business Profile: its locations, their Google reviews and their daily views, calls, direction requests and website clicks, so marketing and clienteling see Google next to Yext, Trustpilot and the store's own reviews.

| Setting | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The instance's Google OAuth client, shared with the other Google connectors |
| `GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN` | The refresh token of a connection with `business.manage` only |
| `GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID` | The account's numeric id, the digits after `accounts/` |

**Read-only by design.** Google offers only one scope for these APIs, `business.manage`, which can also change a profile. So the connection holds `business.manage` and nothing else, which the client checks on every new access token, and the client sends only GETs to three fixed paths under the one account in the settings, with query strings it builds itself: the location list (Business Information v1, asking only for each location's name, title and store code), each location's reviews (My Business v4) and each location's daily metrics (Business Profile Performance v1). Its only other request is the token refresh. Replying to a review is declared behind the write gate, needing approval, turned off, and the client has no request to send it. Google approves Business Profile API access per project on request; a project without it is turned down with a 403.

**What it reads.** Each sync reads the account's locations first, then each location's reviews newest change first, down to where the sync starts, then its daily metrics a month-long window at a time. The first import reads two years back. Each later sync reads reviews changed since the newest change the last one saw, less a day, and metrics again from a week before the last day read, since Google keeps filling in recent days; the first later sync looks back three days for reviews and ten for metrics. A row read again unchanged is a duplicate.

**Events.**
- `location.updated` for each location: its name and store code.
- `review.updated` for each review, in the shape the Yext and Trustpilot connectors give: the rating, an excerpt with emails and phone numbers masked, whether it was left anonymously, whether and when the store replied and the reply's state, and when it was written and edited. Two stars or fewer is marked for follow-up.
- `analytics.local_listing_reported` for each location and day: Maps and Search views on desktop and mobile, direction requests, calls, website clicks, messages and bookings. Google leaves a zero out, so a metric it doesn't give is zero.

**Privacy.** The reviewer's name and photo are never kept, nor the text of the store's reply. Locations' addresses, phones and hours aren't asked for.

**Rate limits.** A 429, 500, 502, 503 or 504 is waited out as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, before the error goes to the sync runner, which resumes from its checkpoint. A token turned down mid-sync is replaced once.

**Testing.** The tests run against a mock built from Google's developer docs (`packages/testkit/src/mocks/google_business_profile.ts`). It checks the token, the account, page sizes and tokens, the review order, the metric names and the date range. The first live run must confirm that a location's name is `locations/` and its id, how far back the Performance API answers, and that page tokens last the length of a sync.

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

### Gorgias

Reads the store's Gorgias helpdesk: every ticket from email, chat and social, and every message on it, so clienteling, sales and repairs see what online customers asked about and how fast the store answered.

| Setting | What it is |
| --- | --- |
| `GORGIAS_DOMAIN` | The helpdesk's subdomain: `store` for store.gorgias.com |
| `GORGIAS_CLIENT_ID` | The client id of the KaratOS app in Gorgias's partner portal |
| `GORGIAS_CLIENT_SECRET` | That app's client secret |
| `GORGIAS_REFRESH_TOKEN` | The refresh token from the store connecting the app to its helpdesk |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** Gorgias API keys carry the full permissions of the user who made them, and the read-only Observer role can't make one, so KaratOS doesn't use a key. It uses an app that asks only for `openid`, `offline` and `tickets:read`. Each sign-in's token lists the app's scopes, and the client stops before reading anything if one of them isn't a read scope, or if the token doesn't say. It sends only three requests to the store's own `https://{domain}.gorgias.com`: the refresh-token sign-in, List tickets and List messages, with parameters it builds itself from checked values and Gorgias's page cursor, never from a link in an answer. Adding an internal note and tagging a ticket are declared behind the write gate, each needing approval, turned off, and the client has no request to send them.

**What it reads.** Gorgias lists tickets by when they last changed, newest first, 100 a page, with a cursor and no time filter. So a pass reads tickets newest first and stops at the first one that last changed before its floor, reading each ticket's messages (oldest first) as it goes. The first import's floor is five years back. Each later sync's floor is the newest change the last pass saw, less five minutes: a new message or a status change moves its ticket to the front, so only changed tickets are read. An unchanged ticket or message is a duplicate. The first later sync looks back two days. Each page of tickets is one batch, and the checkpoint keeps the floor, the newest change seen and Gorgias's cursor, so a resumed pass goes on from the page it reached.

**Events.**
- `communication.ticket_updated` for each ticket: status, channel and how it came in, tags (the store's own labels, lowercased, up to 20), the assigned agent (Gorgias's user id), whether the store started it, spam, trashed or unread, the satisfaction score, and when it was created, opened, last received a message, last had a message, was closed, is snoozed until and last changed.
- `communication.message_logged` for each message: the channel, the ticket as its conversation, inbound, outbound or an internal note, the agent who wrote it, how long its text was, how many attachments, whether a rule sent it, whether it failed or was deleted, and when it was sent and opened.

Each event is keyed by a digest of what was kept. A ticket without an id, a creation time or a status, or a message without an id, a ticket, a time or who wrote it, is dead-lettered.

**Privacy.** Message text, HTML, subjects, attachments, customer names and notes are never read into an event. Customers' emails become the same customer references custom forms, Klaviyo, Quo and AvaTax make (an HMAC under `CUSTOMER_REF_KEY`), so one person lines up across systems without the address being kept. Staff are Gorgias's user ids.

**Rate limits.** Apps get 80 requests in 20 seconds. The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. It signs in again once on a 401. A 403 says the app lacks `tickets:read`; a 404 says the subdomain is wrong.

**Testing.** Gorgias apps are made in its partner portal. The tests run against a mock built from Gorgias's developer docs (`packages/testkit/src/mocks/gorgias.ts`). It checks the Basic auth and the refresh grant, the bearer token, the parameters each list takes, the sort and the page size. It lists what the first client's connection must confirm: how the refresh grant authenticates, that the scope is space-separated, that a new message moves its ticket's `updated_datetime`, that times are UTC, and the satisfaction score's shape.

### Gusto

Reads one company's processed payrolls from Gusto's App Integrations API, asking for API version `2026-06-15` on every request. Read-only is enforced twice. The app holds only the `payrolls:read` scope, and after every token refresh the client calls `GET /v1/token_info` and stops if the token belongs to a company other than `GUSTO_COMPANY_UUID`, holds any scope that doesn't end in `:read`, or doesn't say which scopes it holds. The client also sends GET requests to two payroll endpoints only, and its only POST is the token refresh. It declares no writes: payroll stays with a person in Gusto.

| Setting | What it is |
| --- | --- |
| `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET` | The KaratOS app's keys from the Gusto developer portal |
| `GUSTO_REDIRECT_URI` | The app's registered redirect URI, which Gusto asks for on every refresh |
| `GUSTO_COMPANY_UUID` | The company's UUID, from `GET /v1/token_info` after connecting |
| `GUSTO_REFRESH_TOKEN` | The refresh token from connecting the company. It only seeds the instance's own copy (below) |
| `GUSTO_ENVIRONMENT` | Optional. `demo` for Gusto's demo environment (`api.gusto-demo.com`); production otherwise |
| `GUSTO_WEBHOOK_VERIFICATION_TOKEN` | Optional. The webhook subscription's verification token, for when webhooks are turned on |

**Tokens.** Access tokens last two hours and are refreshed five minutes early, one refresh at a time. Each refresh returns a new refresh token, and Gusto revokes the old one the first time the new access token is used, so the new one is saved before anything else happens. The instance keeps it in its database, sealed the same way as QuickBooks' and Xero's. An `invalid_grant` error means the company needs reconnecting.

**What it reads.** `GET /v1/companies/{company}/payrolls` for processed payrolls with their totals, by check date, oldest first, 100 per page, then `GET /v1/companies/{company}/payrolls/{payroll}` for each one's employee compensations. The historical import reads three years back in windows of at most a year, which is as much as Gusto lists at once. Incremental syncs read again from 45 days before the previous pass, so a payroll processed late or changed after processing is picked up. Both reach 31 days ahead, since Gusto processes a payroll days before its check date. Unprocessed payrolls aren't read, since their numbers can still change. Reversed and cancelled payrolls aren't handled yet.

**Rate limits.** Gusto allows 200 requests a minute per company and app. A 429 is waited out (`Retry-After` when sent, at most a minute, three tries) before the error goes to the sync runner.

**Events.** `payroll.payroll_processed` for each payroll: check date, pay period, regular, off-cycle or external, and gross pay, net pay, employer and employee taxes, benefits, reimbursements, bonuses, commissions and the company debit in whole cents. `payroll.employee_paid` for each employee it paid: gross and net pay, hours, overtime, commissions, bonuses and tips, and the payment method. Employees are named by Gusto's employee UUID only; no names, pay rates, bank details, tax withholdings or deductions are kept. Gusto has no version number on a payroll, so each event is keyed by a hash of what was kept, and a replay is a duplicate. A payroll with no readable check date is dead-lettered rather than given a made-up day.

**Finance.** The finance department turns these into payroll signals, and flags a regular payroll whose gross pay is more than 25% (and at least $500) above the average of the three before it on the same pay schedule, so it gets a second look.

**Webhooks.** `verifyGustoWebhook` checks `X-Gusto-Signature`, the HMAC-SHA256 of the raw body keyed with the verification token. Gusto's docs don't say whether the digest is hex or base64, so both are accepted, compared in constant time; the nightly sandbox run is where that gets confirmed. Gusto retries a delivery for up to three days and signs no timestamp, so `gustoWebhookEvent` returns the event's uuid to drop replays by, and only events for this company. A payroll event is a prompt to sync, not data. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** The tests run against a mock built from Gusto's docs (`packages/testkit/src/mocks/gusto.ts`), which replaces refresh tokens and revokes the old one on first use of the new access token, answers `token_info`, needs the API version header and enforces the one-year window and paging. For the nightly run, create a Gusto developer account, make a demo company with a few synthetic employees and processed payrolls, connect it to a test app with only `payrolls:read`, and add `SANDBOX_GUSTO_CLIENT_ID`, `SANDBOX_GUSTO_CLIENT_SECRET`, `SANDBOX_GUSTO_REDIRECT_URI`, `SANDBOX_GUSTO_COMPANY_UUID` and `SANDBOX_GUSTO_REFRESH_TOKEN` as GitHub Actions secrets. The nightly run can't save the replacement refresh token, so expect `invalid_grant` after its first use until the run can store tokens.

### HRD Antwerp report check

Looks up the HRD Antwerp reports behind the report numbers the business holds, through HRD's public MyHRD API, and checks each night that they are still valid. It confirms what each stone or jewel is before it is sold, insured or bought, and flags a number HRD has no report for.

| Setting | What it is |
| --- | --- |
| `HRD_API_TOKEN` | A MyHRD API token, requested through API Access in MyHRD |
| `HRD_REPORT_NUMBERS_FILE` | A text or CSV file of report numbers, one per line in the first column. Blank lines and lines starting with `#` are skipped; a line holding anything else stops the sync, naming the line but not its contents |
| `HRD_MAX_LOOKUPS_PER_SYNC` | Optional. The most numbers one sync looks up, 50 when unset |

**What it reads.** Each sync looks up the numbers on the list it hasn't looked up yet, 25 to a checkpoint. HRD allows 1000 lookups a day and 100 requests in 15 minutes, so a sync looks up at most `HRD_MAX_LOOKUPS_PER_SYNC` and the rest wait for the next one. Then, once a night while HRD answers it (19:00 to 04:00 UTC), it asks which of the reports it found are still valid, 1000 numbers to a request. A report whose valid-from date moved has been reissued and is looked up again on the next sync. A number taken off the list is neither looked up again nor checked.

The client sends two requests only, `GET /GetReport/{reportNumber}` and `POST /GetReportValidities`, to `https://my.hrdantwerp.com/api/public` and nowhere else, with report numbers it checked: up to two capital letters and 6 to 14 digits. It waits a quarter second between requests, and waits out a 429 or a 5xx three times; a 400 says the token was turned down without showing it. Answers are XML, read by a small reader that refuses document type declarations and entities of its own, so nothing in an answer is expanded or fetched.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `grading.report_retrieved` | A report found by lookup. For a diamond: report type, kind (natural or lab-grown diamond, melee or other), issue date, shape, carat weight as a number, color, clarity, cut, polish, symmetry, fluorescence, measurements, inscription, remarks, hearts and arrows, origin and proportions. For a jewel: jewel type, metal, diamond count, total carat weight, description, remarks, the stones and which report types exist | report number and a hash of what is kept, so a changed report is a new event and the same one read again is a duplicate |
| `grading.report_unavailable` | A number HRD has no report for (`not_found`), or a report the validity check no longer lists (`no_longer_valid`) | report number and reason, so it is recorded once |

A report's time is its issue date; one without a readable date or number is dead-lettered with the raw event kept. PDF links are not kept, since they need the token to open. No department reasons over these events yet.

**Writes.** None. Report results are HRD's to change.

**Testing.** The tests run against a mock built from HRD's API guide (`packages/testkit/src/mocks/hrd.ts`), with synthetic diamond and jewel reports. HRD offers no sandbox; a token comes on request through MyHRD.

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

### IDEX Online

Reads the business's IDEX Onsite feed: the diamonds it offers from the IDEX trading network on its own website, with the filters and markups it set on IDEX. Buying and sales see what can be offered and at what price, and which stones were repriced or sold. It needs an IDEX trading subscription with the Onsite add-on.

| Setting | What it is |
| --- | --- |
| `IDEX_API_KEY` | The API key IDEX issues for the Onsite feed |
| `IDEX_API_SECRET` | The secret that comes with it. It is sent only to IDEX's two Onsite feed addresses, which are fixed in the client |
| `IDEX_FEEDS` | Optional. `natural`, `lab_grown` or both, comma-separated; `natural` when unset. The lab-grown feed is a separate IDEX add-on |
| `IDEX_MAX_STONES` | Optional. The most stones one feed may hold before the sync stops and asks for narrower filters, 50,000 when unset |

**What it reads.** Each sync asks IDEX for the whole feed as an unzipped CSV file (`format_20230628_extended` for natural stones, `format_lg_20221130` for lab-grown ones) and compares it with the last one read. IDEX makes a new file every hour or two and answers the previous one until then. A stone that is new, or whose grades or price changed, is recorded; one that left the feed is recorded as delisted, and one that comes back is recorded again. An empty file never delists the feed: the sync stops instead, since an empty file is far more likely a filter mistake than every stone selling at once. Files over 200 MB are not read.

IDEX's errors (HTTP 500 with a `result_info` code) stop the sync with the code and IDEX's description, with the key and secret taken out. A 429 waits as Retry-After says, up to a minute, three times.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `diamond_listing.listed` | A stone new to the feed or changed: IDEX item number, supplier stock number, shape, carat weight, color or fancy color, clarity, cut grade, polish, symmetry, lab and certificate number, price per carat and total price in cents after the business's markup, % off the IDEX list, measurements, proportions, fluorescence, shade, milkiness, eye-clean, brand, provenance, availability, location, and whether a certificate file, image, video or 3D view exists | feed, item number and a hash of what was read, plus how often the stone left the feed before |
| `diamond_listing.delisted` | A stone that left the feed | feed, item number and which departure this is |

A listing's time is when KaratOS saw it, since the feed doesn't say when a stone was listed. Media links aren't stored: they point at supplier hosting. A row without a readable item number, shape, carat weight or price, or one that repeats an item number, is dead-lettered with its line number and what was wrong; the rest of the feed is still read. A file missing a required column stops the sync, naming the columns. No department reasons over these events yet.

**Writes.** Declared and turned off: uploading the business's listings to IDEX, and asking a supplier to hold or send a stone.

**Testing.** The tests run against a mock built from IDEX's API pages (`packages/testkit/src/mocks/idex.ts`), which answers both feeds with synthetic stones under IDEX's documented header rows. It is checked live once a subscriber's key is connected.

### Any other mailbox (IMAP)

Reads one mailbox at any provider that offers IMAP, for stores whose mail isn't on Google or Microsoft: who wrote to whom, when and in which thread, from its INBOX and its Sent folder. It speaks IMAP4rev1 ([RFC 3501](https://www.rfc-editor.org/rfc/rfc3501)) itself, over Node's own TLS, and its events are the ones the Gmail connector gives, so a message read over IMAP reads like one from Gmail.

| Setting | What it is |
| --- | --- |
| `IMAP_HOST` | The IMAP server's host name, such as `imap.example.com` |
| `IMAP_PORT` | Optional: its port for IMAP over TLS; 993 when empty |
| `IMAP_USERNAME` | The mailbox's sign-in name, usually its address |
| `IMAP_PASSWORD` | An app password for the mailbox |
| `CORRESPONDENT_HASH_KEY` | The instance's key for correspondent references, shared with Gmail and Outlook |

**Sign-in.** The connector connects with implicit TLS (TLS from the first byte, port 993 by default), checks the server's certificate against `IMAP_HOST` and asks for TLS 1.2 or later. STARTTLS (port 143) and plaintext aren't supported. It then signs in with `LOGIN`, the username and the app password, as quoted strings (or literals, if either holds characters outside printable ASCII); the password never appears in a log, an error or a checkpoint. Most providers won't take the account's own password over IMAP once two-step sign-in is on, and ask for an app password instead. A `NO` or `BAD` to `LOGIN` stops the sync with a message naming `IMAP_USERNAME` and `IMAP_PASSWORD` and the server's response code, such as `AUTHENTICATIONFAILED`, but not its text. A server that advertises `LOGINDISABLED` stops it the same way. The settings are checked before anything is sent: the host must be a host name (no scheme, port or path) and the port a whole number from 1 to 65535. A connection or TLS failure, a dropped connection or a server that says nothing for a minute is an error that the next attempt retries, naming the host and port and the system's error code only.

**Read-only.** The client can send seven commands and no others: `CAPABILITY`, `LOGIN`, `LIST`, `EXAMINE`, `UID SEARCH`, `UID FETCH` and `LOGOUT`. Folders are opened with `EXAMINE`, which the server opens read-only, never `SELECT`. Messages are fetched with exactly `(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC MESSAGE-ID IN-REPLY-TO REFERENCES)])`: `BODY.PEEK` leaves the `\Seen` flag alone, and no body, attachment or subject is ever fetched. There is no way to send `STORE`, `COPY`, `MOVE`, `EXPUNGE`, `APPEND`, `CREATE` or `DELETE`. An IMAP password isn't scoped, though, so it could do all of that in other hands: keep it in the host's secret store and revoke it when the connector is turned off.

**What it reads.** Each pass lists the folders and reads INBOX and the Sent folder: the one `LIST` marks `\Sent` (the special-use attribute), else one named Sent, Sent Items, Sent Messages or Sent Mail (or the same under `INBOX.`). Folders marked `\Noselect` are skipped. The historical import searches each folder with `UID SEARCH SINCE <day>` for five years back, oldest first, and fetches the messages 50 to a batch. Each batch's checkpoint keeps, per folder, its name, its `UIDVALIDITY` and the last UID read, so an interrupted import searches again past that UID (`UID SEARCH UID <last+1>:* SINCE <day>`) and goes on. Incremental syncs fetch each folder's messages past the last UID read, with `UID FETCH <last+1>:*`; since `*` stands for the highest UID, that also answers with the last message when nothing is newer, which is dropped. The first incremental sync, with no checkpoint of its own, searches back 48 hours. When a folder's `UIDVALIDITY` changes, the server has renumbered it and every UID kept for it means nothing, so that folder is read again from five years back; messages already stored come back as duplicates. A folder that is finished also takes its `UIDNEXT`, so a quiet folder isn't read from the start next time.

**Events.**

- `communication.message_logged` for each message, as Gmail's: its reference, its thread's reference, `direction` (`sent` for the Sent folder, otherwise `received`), `sentAt` from `INTERNALDATE`, the sender and the To and Cc recipients as correspondent references (50 at most each, with `recipientCount` exact), and `labelIds` in Gmail's names: `INBOX` or `SENT`, `UNREAD` without `\Seen`, `STARRED` with `\Flagged`. It is keyed by the message's reference and its labels, so the same message read in two folders is two versions and a replay is a duplicate.
- `communication.label_updated` for INBOX and SENT, as system labels, once a pass.

IMAP keeps no message or thread ids that last, so a message's reference is a keyed digest (under `CORRESPONDENT_HASH_KEY`) of its `Message-ID`, or without one of its folder, `UIDVALIDITY` and UID; its thread's is a keyed digest of the first id in `References`, else `In-Reply-To`, else its own. A `Message-ID` can hold the sender's address, so neither is kept as it was. Addresses become the same correspondent references Gmail's and Outlook's connectors make, with the domain kept only for businesses. Display names are dropped before RFC 2047 encoded words ([RFC 2047](https://www.rfc-editor.org/rfc/rfc2047)) are decoded; a field is decoded and read again only when it holds no address otherwise, as when a mailer has encoded the whole field. Drafts (`\Draft`) are skipped. A message with no `INTERNALDATE` that reads, or whose header fields didn't come back or are longer than 64 KiB, is dead-lettered with what was wrong, keyed by a sha256 digest.

What isn't seen: a flag that changes on a message already read, a message deleted later, folders other than INBOX and Sent, and mail older than five years.

**Writes.** Saving a draft reply and flagging a message are declared behind the write gate, as Gmail's draft and label writes are, needing approval each time and turned down while writes are off. The client has no command that could do either.

**Testing.** There is no vendor and no sandbox. The connector is tested against a scripted RFC 3501 server in the test kit (`packages/testkit/src/imap.ts`), which answers the commands above over an in-memory transport, cuts its answers into small chunks so lines and literals arrive split, answers anything else `BAD` and records it, and marks a message read if it is ever fetched without `PEEK`. What the first live mailbox must confirm: that the provider marks its Sent folder `\Sent` or names it as above, that it sends `UIDNEXT` with `EXAMINE`, and how its `SEARCH SINCE` treats time zones (RFC 3501 compares dates only, so the five-year edge may move by a day).

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

### Judge.me

Reads a shop's Judge.me reviews, each on the product and customer it is about, with reviews of two stars or fewer marked for follow-up. Reviews arrive as the same `review.updated` events the Yext, Birdeye and Yotpo connectors give.

| Setting | What it is |
| --- | --- |
| `JUDGEME_SHOP_DOMAIN` | The shop's domain, such as `example.myshopify.com` |
| `JUDGEME_API_TOKEN` | An OAuth token with only `read_reviews`, or the private API token |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** Judge.me's private API token reads and writes alike: it could post reviews and change what is published. An OAuth token can be limited to `read_reviews`, and that is the one to use when the shop can grant it. Either way the client is what keeps KaratOS to reading: its only request is a GET of the review list (`api.judge.me/api/v1/reviews`), to Judge.me's fixed address, with a query built from checked values. Replying to a review and publishing or hiding one are declared behind the write gate, turned off, and the client has no request to send them. Judge.me takes the token in the query string, so no error the client raises carries a URL.

**What it reads.** Every page of the shop's reviews, 100 to a page by page number, since Judge.me has no filter by date. The first import keeps the reviews posted or changed in the last five years. Each later sync keeps the ones changed since two days before the last pass started. Each page is one batch and one checkpoint.

**Events.** `review.updated` for each review, with its id, whether it is about a product (and the product's id on the store platform) or the store, the rating, whether it needs follow-up, the title and an excerpt with email addresses and phone numbers masked, where it came from, its curation and verification status, whether it is published or hidden, how many photos show, the reviewer's Judge.me reference and customer references, and when it was posted and last changed. Each is keyed by a digest of what was kept, so an unchanged review is a duplicate. A review without an id, a rating or a time that reads is dead-lettered.

**Privacy.** Reviewers' email addresses and phone numbers only make keyed customer references. Names, IP addresses, marketing tags and photo links aren't kept.

**Rate limits.** Judge.me doesn't document one. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time.

**Testing.** Judge.me has no sandbox, so the tests run against a mock built from Judge.me's docs (`packages/testkit/src/mocks/judgeme.ts`). It checks the shop domain, the token and paging, and lists what the first client's shop must confirm: the order reviews come back in, whether hidden and unpublished reviews are listed, and the time zone of Judge.me's times.

### Klaviyo

Reads Klaviyo's JSON:API (`https://a.klaviyo.com/api/...`) with a private API key, sending the `revision` header pinned to 2026-10-15, the revision the connector was built against.

| Setting | What it is |
| --- | --- |
| `KLAVIYO_PRIVATE_API_KEY` | A private key (`pk_`) made as a Custom Key with Read Access to Profiles, Lists, Segments, Campaigns, Flows and Metrics (`profiles:read`, `lists:read`, `segments:read`, `campaigns:read`, `flows:read`, `metrics:read`) and No Access to everything else |
| `CUSTOMER_REF_KEY` | Generated. Keys the customer references (below); the same key custom forms, Square and WooCommerce use |
| `KLAVIYO_CONVERSION_METRIC_ID` | Optional. The metric the reports count conversions and revenue by. Empty means the metric named Placed Order |
| `KLAVIYO_WEBHOOK_SECRET` | Optional. The `secret_key` of a system webhook, for accounts that have webhooks |

**Read-only.** Klaviyo documents no way to read the scopes a private key holds, keys can't be edited after they are made, and keys made before scopes existed have full access. So the connector can't check the key the way it checks Square and HubSpot tokens; the allowlist in the client is the guard. Every GET must be one of eight listed endpoints with its listed parameters, and each filter (one `greater-than` on a time field), sort, page size, sparse fieldset and cursor is checked before the request is made. The only POSTs are Klaviyo's two reporting endpoints, `POST /api/campaign-values-reports/` and `POST /api/flow-values-reports/`. Klaviyo serves reports as POSTs because the query is a JSON body, but they only return aggregates. They are allowed by exact path, with no query string, and only with a body the client builds itself: the report type, a fixed list of count statistics, a timeframe of at most a year, a metric id and the group-by fields. A body with anything else is stopped. Adding profiles to a list, subscribing, creating events (which is how flows are triggered) and every other write never leave the server, whatever the key allows. Still give the key read access only.

**What it reads.** Profiles, then lists and the profile ids in each list, then segments and their profile ids, then campaigns and flows: all of them on the first import, since they are current state. Then the metrics list, to find the conversion metric, and the campaign and flow values reports for five years, one calendar year per report (Klaviyo's longest timeframe), grouped by message and channel. Every listing is paged with the cursor in `links.next`; a next link that doesn't continue the same request (another host, path or query, or a cursor that doesn't look like one) stops the sync rather than being followed or ending it early. Each page is one batch, so a crash resumes at the next page. Incremental syncs read profiles, campaigns and flows changed since the last pass started (`filter=greater-than(updated,...)`), members who joined each list and segment since then (`joined_group_at`), and the reports for the calendar years the last 30 days touch, since conversions keep being attributed to a message after it is sent. With no checkpoint the first pass looks back 48 hours. Klaviyo rate-limits each endpoint with a per-second burst and a per-minute steady rate (the reports allow 1 a second, 2 a minute and 225 a day) and answers 429 with `Retry-After` in seconds. The client waits that long, up to a minute, three times, then leaves the error to `runSync`, which retries from the checkpoint; a longer wait (the reports' daily cap) is left to the next run.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `customer.profile_updated` | A profile: consent to email and text marketing, created and updated times, in the clienteling shape | profile reference and `updated` |
| `marketing.group_membership_seen` | A profile in a list or segment | group and profile reference |
| `marketing.list_updated`, `marketing.segment_updated` | A list's name and opt-in process, a segment's name and whether it is active | group and `updated` |
| `marketing.campaign_updated`, `marketing.flow_updated` | Name, archived flag, a flow's status and trigger | campaign or flow and its update time |
| `marketing.campaign_metrics_reported`, `marketing.flow_metrics_reported` | Recipients, deliveries, bounces, opens, clicks (all and unique), conversions, revenue in cents and unsubscribes, per message, channel and calendar year | message, channel, year and a digest of the figures |
| `campaign.sent` | A campaign message that reached anyone, in the marketing department's shape with `costCents` 0, as Klaviyo holds no cost | campaign, message and channel |
| `marketing.consent_changed` | A webhook for a subscribe, unsubscribe or suppression | Klaviyo's event id |

**Privacy.** Profiles are asked for with sparse fieldsets (`email`, `phone_number`, `created`, `updated` and `subscriptions`), so names, locations, organizations and custom properties never reach the server. Email addresses and phone numbers are used only to make references and are never stored, and segment definitions, which can name a person, are never asked for. Each profile gets a profile reference, an HMAC-SHA256 of its Klaviyo id keyed with `CUSTOMER_REF_KEY`, which never changes, so memberships and consent changes link to it. It also gets contact references made exactly the way custom forms makes them, from the normalized email address and phone number, and its `customerId` is the email's reference when it has one. Square and WooCommerce key their references by their own customer ids, which Klaviyo doesn't know, so an id can't link Klaviyo to them; the email address is the one detail Klaviyo and a form submitter share, so a Klaviyo profile and a form submission from the same address name the same customer. Campaign and flow figures are kept only in aggregate; per-person opens and clicks are never read.

**Webhooks.** Only Advanced KDP customers and Klaviyo app partners can create system webhooks, so most accounts rely on the scheduled sync. `verifyKlaviyoWebhook` checks `Klaviyo-Signature`, the hex HMAC-SHA256 keyed with the webhook's secret over the raw body followed directly by the `Klaviyo-Timestamp` header, in constant time. It rejects a timestamp more than five minutes off, so a captured delivery can't be replayed later, and a body whose `meta.klaviyo_webhook_id` doesn't match `Klaviyo-Webhook-Id`, as Klaviyo advises. `KlaviyoReplayGuard` handles each event's `external_id` once, and the event keys make a redelivery a duplicate. Email and SMS consent topics become `marketing.consent_changed`; other topics are per-person activity and are dropped. The instance doesn't take webhooks yet.

**Testing.** Until a Klaviyo account is set up for the nightly run, the tests run against a mock built from Klaviyo's API reference (`packages/testkit/src/mocks/klaviyo.ts`). It answers 401 without the key and 400 without a revision, applies sparse fieldsets, binds each cursor to its query, and checks report bodies the way the reference describes. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, create a free Klaviyo account for testing only, add a few synthetic profiles, a list, a campaign and a flow, make a private key with the read scopes above, and add it as the `SANDBOX_KLAVIYO_PRIVATE_API_KEY` GitHub Actions secret. The writes it may do later (add profiles to lists, trigger flows) are declared, and the write-gate test shows each one is stopped.

### Lightspeed Retail

Reads a store's products, stock at each outlet, customers, and sales and returns from Lightspeed Retail X-Series (formerly Vend), for the sales, inventory and clienteling departments. R-Series, Lightspeed's other retail product, has a separate API and isn't covered.

| Setting | What it is |
| --- | --- |
| `LIGHTSPEED_DOMAIN_PREFIX` | The store's prefix, the part before `.retail.lightspeed.app` |
| `LIGHTSPEED_CLIENT_ID` | The client ID of the KaratOS app on Lightspeed's X-Series developer portal |
| `LIGHTSPEED_CLIENT_SECRET` | That app's client secret, which also encrypts the stored refresh token |
| `LIGHTSPEED_REFRESH_TOKEN` | The refresh token from connecting the store; it only seeds the stored one |
| `CUSTOMER_REF_KEY` | The instance's customer reference key, shared with Square and the custom forms |

**Sign-in.** The store is connected over OAuth at `https://secure.retail.lightspeed.app/connect` with exactly `products:read inventory:read customers:read sales:read`. The client refreshes at `POST https://<prefix>.retail.lightspeed.app/api/1.0/token`. Every refresh gives a new refresh token, which is saved (encrypted, in the instance's database) before anything else, and only one refresh runs at a time. Lightspeed reports the scopes granted on every token response; the connector stops if any scope isn't a read scope, if none is reported, or if the token belongs to a different store. A 401 refreshes once.

**What it reads.** Each pass reads `GET /api/2026-10/products`, `POST /api/2026-10/inventory` (Lightspeed's inventory list is a search sent as a POST; it needs only `inventory:read`), `GET /customers` and `GET /sales`, in that order. Lightspeed pages by version: every change gives a record a higher version, and each list is asked for what's after the version the last page reached, until an empty page comes back (for inventory, a page short of 1,000). The checkpoint keeps each list's version, so every pass reads only what changed since the last. The first import reads every product, stock level and customer and five years of sales. Lightspeed can't filter by date, so older sales are skipped as they are read, and an incremental sync with no checkpoint of its own reads everything once, with what the import stored coming back as duplicates. Lightspeed allows 300 calls per register plus 50 every five minutes; a 429 (or a 502, 503 or 504) is waited out three times, honoring `Retry-After` in seconds or as a date up to a minute, before the sync stops and resumes from its checkpoint.

Inventory records name a product, not its SKU. The connector keeps the SKUs of products it has read in the run and asks `GET /api/2026-10/products/{id}` for any it hasn't, so stock and sales carry the same SKUs.

**Events.** The same types the Square connector gives:

- `order.updated` for each version of a sale: its state, outlet, register, total, line count, customer reference, and when it was voided or deleted.
- `sale.completed` once a sale is closed, keyed by sale so an edit never counts it twice: each line's SKU, quantity, unit price before discount and discount, the total with tax, and how it was paid (the store's payment type names read as card, cash, check, gift card, financing, wire or other).
- `sale.returned` for lines taken back (a negative quantity), with the refund per line, against the original sale when Lightspeed links one. An exchange gives both.
- `product.updated` with the product's one variant, its SKU and price before tax, and whether it's active, archived or deleted.
- `inventory.counted` for each outlet's stock of a product, dated when it was read, as Lightspeed's records carry no time. A negative or fractional level is dead-lettered by the inventory schema.
- `customer.profile_updated` under a keyed reference, with a label in place of a name and marketing consent off, since Lightspeed's `do_not_email` only records opting out.

A sale with no readable date is dead-lettered. Customer names, emails, phone numbers, birthdays, addresses, notes and balances are never kept, nor sale notes, staff names, gift card numbers or costs.

**Writes.** `adjust_inventory` is declared behind the write gate and turned down while writes are off; no write scope is asked for. Lightspeed's webhooks aren't used: the scheduled sync reads changes by version.

**Testing.** The mock (`packages/testkit/src/mocks/lightspeed.ts`) is built from Lightspeed's developer docs, and its assumptions list what the first live run must confirm, among them the default page size, error bodies, and that a sale line's `price` is after its discount. The nightly sandbox run reads a trial store once the `SANDBOX_LIGHTSPEED_*` secrets are set. As with Xero, the run can't save the new refresh token, so the secret needs updating after each run.

### Mailchimp

Reads one Mailchimp account through the Marketing API (3.0) on the data center its API key names. A Mailchimp API key can't be limited to reading, so read-only is enforced in the client: it sends GET requests for five listed reads only (ping, audiences, audience members, campaigns and campaign reports), with parameters it checked, and throws before sending anything else. The one write it may do later (add a contact to an audience) is declared and stays behind the write gate.

| Setting | What it is |
| --- | --- |
| `MAILCHIMP_API_KEY` | An API key from Profile > Extras > API keys, ending in the account's data center (such as `-us21`) |
| `CUSTOMER_REF_KEY` | The instance's customer reference key, shared with custom forms, Calendly and Klaviyo |
| `MAILCHIMP_WEBHOOK_SECRET` | Optional. A random secret for the webhook URL, for when webhooks are turned on |

**Privacy.** Every read names the fields it wants (`fields=`), so names, phone numbers, addresses, birthdays, merge fields, tags, locations and subject lines never leave Mailchimp. A member's email address comes back only to become the same keyed reference custom forms makes for it, so a subscriber lines up with the same person's form submissions, Calendly bookings and Klaviyo profile. Mailchimp's member id is the MD5 of the email address, which anyone can recompute from a guess, so it is never kept.

**What it reads.** The historical import reads every audience, every member of each (1000 a page, oldest change first), and the campaigns sent in the last five years with each one's report. Incremental syncs read the audiences again, the members changed since the previous pass started (less five minutes), and the campaigns sent from 30 days before that, since a report keeps growing as opens and clicks come in.

**Rate limits.** Mailchimp allows 10 requests at once. The client sends one at a time and waits out a 429 (`Retry-After` when sent, at most a minute, three tries) before the error goes to the sync runner.

**Events.** The same types as Klaviyo: `marketing.list_updated` for audiences, `customer.profile_updated` with `marketingConsent` true only for subscribed members, `marketing.group_membership_seen`, `marketing.campaign_updated`, `marketing.campaign_metrics_reported` with sends, bounces, opens, clicks, orders, revenue in cents, unsubscribes and abuse reports, and marketing's `campaign.sent` once emails went out (cost 0, as Mailchimp has none per campaign). Members are keyed by audience, reference and last change, and reports by a digest of their numbers, so a replay is a duplicate.

**Webhooks.** Mailchimp doesn't sign deliveries. `verifyMailchimpWebhook` checks the `key` query parameter the instance put in the webhook URL against `MAILCHIMP_WEBHOOK_SECRET`, in constant time. `mailchimpWebhookEvent` reads a delivery's type, audience and time from its form body and nothing about the member. A delivery is a prompt to sync. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** The tests run against a mock built from Mailchimp's docs (`packages/testkit/src/mocks/mailchimp.ts`), which needs Basic auth, applies `fields`, filters by `since_last_changed` and `since_send_time`, sorts and pages. For the nightly run, make a free Mailchimp account with one audience of `example.test` addresses and a test campaign, and add its key as the `SANDBOX_MAILCHIMP_API_KEY` GitHub Actions secret.

### Meta Ads

Reads one ad account's Facebook and Instagram campaign insights by day through Meta's Marketing API (Graph API v26.0). Read-only three ways over: the token holds `ads_read` and nothing else, which the client checks against `/me/permissions` before its first read; its only other request is the insights read for the ad account in the settings, with parameters built from one fixed report; and it never follows a link Meta returns, rebuilding each next page from the cursor instead.

| Setting | What it is |
| --- | --- |
| `META_ADS_ACCESS_TOKEN` | A system user token from the store's Meta Business account, with `ads_read` only and the ad account assigned |
| `META_ADS_ACCOUNT_ID` | The ad account's numeric id, with or without `act_` |

**What it reads.** One report at campaign level, a 31-day window at a time, by day, 500 rows a page: for each campaign, its objective and the account's currency, and the spend, impressions, reach, clicks, purchases and purchase value. The historical import reads two years up to today. Each incremental sync reads again from two weeks before the last day the previous pass read, since Meta keeps attributing purchases to past views and clicks.

**Privacy.** Insights are totals by campaign and day, so nothing names a person. Campaign names are cut short, and one holding an @ is dropped.

**Rate limits.** Meta throttles by app, user and ad account, answering Graph error codes 4, 17, 32, 613, 80000 or 80004 (or HTTP 429). The client sends one request at a time and waits, doubling from a second, three tries, before the error goes to the sync runner, which resumes from its checkpoint next time. Error 190 means the token expired or was revoked; 200 or 10 means the ad account isn't assigned to the system user.

**Writes.** Pausing a campaign and changing its daily budget are declared, so they can be gated and audited, and both are turned off. Each needs a named person's approval and is capped at five a day. Turning them on would also need a token with `ads_management`, which the connector stops on today.

**Events.** `ads.campaign_reported`, the same event Google Ads gives, one per campaign and day, with money in cents and purchases counted from Meta's `purchase` action. Each is keyed by its day, its campaign and a digest of its numbers, so a revised row is stored as a new version and an unchanged one is a duplicate.

**Testing.** The tests run against a mock built from Meta's docs (`packages/testkit/src/mocks/meta_ads.ts`), which checks the token, `ads_read`, the ad account, campaign level by day, the fields, the time range and that a cursor belongs to its read. For the nightly run, create a sandbox ad account from a Meta developer app (Marketing API > Tools), make a system user token for it with `ads_read` only, and add `SANDBOX_META_ADS_ACCESS_TOKEN` and `SANDBOX_META_ADS_ACCOUNT_ID` as GitHub Actions secrets.

### Metals-API

Spot prices for gold, silver, platinum and palladium from [Metals-API](https://metals-api.com/documentation), in US dollars per troy ounce, as the metals department's `metal.price_updated` events. They feed melt values for inventory and for gold bought from the public, and the metals department's alert when a price moves 5% or more.

| Setting | What it is |
| --- | --- |
| `METALS_API_KEY` | The access key from the Metals-API dashboard |
| `METALS_API_HISTORY_DAYS` | Optional. Days of daily closing prices the first import reads, 1 to 1825. A year when empty |

**What it reads.** The historical import reads one closing price a day for each metal, ending yesterday, since Metals-API won't give a timeseries that includes today. Each request covers up to 30 days of one metal, so a year costs 52 requests and five years 244: check the plan's monthly allowance before raising `METALS_API_HISTORY_DAYS`. The checkpoint fixes the first and last day when the import starts and counts the requests already read, so a resumed import asks for exactly the same stretches. Each incremental sync reads the latest prices for all four metals in one request.

**Prices.** With US dollars as the base, Metals-API sends `XAU` as troy ounces per dollar, so the price is its inverse; the latest endpoint also sends `USDXAU`, the price itself, which wins when present. Prices are stored as whole cents. A quote that is missing, zero, negative or absurd (under a cent or over a million dollars an ounce) is skipped rather than stored. An answer in any base other than US dollars stops the sync.

**Events.** A daily close is keyed by metal and day and stands for the end of that day (`23:59:59Z`); a latest quote is keyed by metal and the time Metals-API gives it. Both carry `quote` (`daily` or `latest`) and `priceDate`.

**Read-only.** The client sends only GET requests with no body, to the latest and timeseries endpoints, for the four metal codes. Metals-API takes the key as the `access_key` query parameter, so request URLs are never put in errors, and an error message that repeats the key has it replaced with `[key]`. There is nothing to write back, and Metals-API has no webhooks.

**Testing.** The tests use a stand-in for the API built from its documentation, with synthetic prices. For the nightly sandbox run, sign up for a free Metals-API account and add its key as the `SANDBOX_METALS_API_KEY` GitHub Actions secret. The run reads a week of history to stay within the free plan's allowance.

### Microsoft OneDrive and SharePoint files

Reads Microsoft Graph (v1.0) for one document library the store chooses, such as a SharePoint site's Documents: its files and folders, then every change, so a department can see a new statement, invoice, appraisal or design file land without anyone moving it. The connector signs in as its own app with a client secret, so nobody signs in again.

| Setting | What it is |
| --- | --- |
| `MICROSOFT_TENANT_ID` | The directory (tenant) id of the store's Microsoft 365 organization |
| `MICROSOFT_CLIENT_ID` | The application (client) id of the store's KaratOS app registration |
| `MICROSOFT_CLIENT_SECRET` | A client secret of that app, sent only to Microsoft's sign-in |
| `MICROSOFT_ONEDRIVE_DRIVE_ID` | The drive id of the library to read. It starts with `b!` |
| `MICROSOFT_ONEDRIVE_FILE_NAMES` | Optional. `keep` (the default) keeps file and folder names; `drop` keeps only ids, kinds and times |
| `MICROSOFT_GRAPH_CLIENT_STATE` | Optional. The clientState a change notification subscription was made with |

**Connecting.** In the Microsoft Entra admin center, register an app named KaratOS (single tenant), remove `User.Read` from its API permissions, add the Microsoft Graph application permission `Sites.Selected` and grant admin consent. That permission alone reaches nothing: an admin then grants the app the `read` role on the one site that holds the library, in Graph Explorer, with `POST https://graph.microsoft.com/v1.0/sites/{site id}/permissions` and the body `{"roles":["read"],"grantedToIdentities":[{"application":{"id":"<client id>","displayName":"KaratOS"}}]}`. Find the site id with `GET /sites/{host}:/sites/{site}?$select=id` and the library's drive id with `GET /sites/{site id}/drives?$select=id,name`. Add a client secret in Certificates & secrets and save its value straight into the host's secret store.

**Read-only.** The app is meant to hold `Sites.Selected` with the `read` role on one site, so it can't see the rest of the organization or change anything. Each sign-in is a client credentials grant for `https://graph.microsoft.com/.default`, and the client reads the token's `roles` claim: if it lists any permission other than `Sites.Selected`, `Lists.SelectedOperations.Selected`, `Files.SelectedOperations.Selected`, `Files.Read.All` or `Sites.Read.All`, the connector stops and says which. It sends only the sign-in and `GET /drives/{drive}/root/delta`. Graph's paging links are never fetched as given: the client reads the delta token out of each one, checks the link is this drive's delta on `graph.microsoft.com` and nothing else, and builds the next request itself. Saving a report and making a notification subscription are declared behind the write gate, and the test shows they are stopped.

**What it reads.** Each request asks Graph for `id`, `name`, `size`, `file`, `folder`, `package`, `root`, `deleted`, `parentReference` and the created and modified times only, so who made or changed an item, its sharing and its links are never fetched. For each file: its id, name, kind (pdf, spreadsheet, document, presentation, image, design or file) and extension, MIME type, its folder's id, created and modified times, size and QuickXorHash. For each folder: its id, name and folder's id. Delta doesn't return paths, so items are tracked by id, and `MICROSOFT_ONEDRIVE_FILE_NAMES=drop` leaves names out too. The library's root isn't an event.

The historical import reads the drive's delta from the start, which lists every folder and file, keeping every folder and each file changed in the last five years. Its last page's delta token becomes the change feed: each later sync asks only for what changed since, including edits, renames, moves and deletions. The incremental sync keeps its own checkpoint, so its first run lists the library once (what the import stored comes back as duplicates) and reads changes from then on. Each batch's checkpoint keeps Graph's token, so a resumed sync asks again from the page it was on. If Graph answers 410 Gone, the library is listed again (at most three times a sync); a deletion in between can't be seen then. A token lasts an hour and a new one is asked for five minutes before it ends; a 401 signs in again once. A 429 or 503 is waited out for `Retry-After` seconds, up to a minute, three times, then left to `runSync`. A 403 says to grant the app the read role, and a 404 to check the drive id.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `document.file_updated` | A file or folder: `onedrive:item:<id>`, its name, kind, folder and the details above | id and a hash of what was read |
| `document.file_removed` | An item with Graph's `deleted` facet: its reference, name and `reason: removed` | id and the page it was read on |

These are the same events Google Drive and Dropbox give. A file with no modified time that reads is dead-lettered. A folder with no modified time and deletions take the time they were read.

**Notifications.** Graph checks a notification address with a POST carrying `?validationToken=`, which `microsoftWebhookValidation` echoes as plain text. Graph doesn't sign notifications: each one carries the `clientState` its subscription was made with, which `webhookPromptsSync` compares in constant time with `MICROSOFT_GRAPH_CLIENT_STATE`. A notification carries no file data, so a matching one prompts the incremental sync, and a replay only prompts a sync that finds nothing new. Graph lets an app subscribe to a drive only with `Files.Read.All`, which reads every site and OneDrive in the organization, so most stores should leave notifications off and sync on a schedule.

**Not yet.** Reading file contents for the statement and invoice imports, as `dropboxFileSource` does for Dropbox, is the next step. A personal OneDrive (consumer account) isn't covered: its app-only sign-in isn't supported.

**Testing.** The tests run against a mock built from Microsoft's client credentials and Graph `driveItem` reference pages (`packages/testkit/src/mocks/microsoft_onedrive.ts`). Its sign-in checks the tenant, client id, secret and scope and gives a JWT whose `roles` claim lists the app's permissions. Every change goes into a log, so a delta token carries on with exactly what changed after it, each item once in its latest state, deletions included; it can expire tokens with 410, revoke access tokens, answer 403 before the read role is granted and answer 429. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, use a Microsoft 365 test tenant with a KaratOS Test site of synthetic statements and invoices, an app given `Sites.Selected` with the read role on that site, and add the `SANDBOX_MICROSOFT_ONEDRIVE_TENANT_ID`, `SANDBOX_MICROSOFT_ONEDRIVE_CLIENT_ID`, `SANDBOX_MICROSOFT_ONEDRIVE_CLIENT_SECRET` and `SANDBOX_MICROSOFT_ONEDRIVE_DRIVE_ID` GitHub Actions secrets.

### Microsoft 365 Outlook mail and calendar

Reads one Exchange Online mailbox's Inbox, Sent Items and calendar through Microsoft Graph (v1.0), for clienteling (who the store writes to and meets, and how recently), buying (which vendors write) and the appointment book. It never reads a message body, a preview, an attachment or a subject, and never keeps an event's title, body, location or meeting link.

**Permissions.** Make an app registration with no Microsoft Graph permissions in Entra at all, then, in Exchange Online, give it the RBAC for Applications roles `Application Mail.ReadBasic` and `Application Calendars.Read`, scoped to the one mailbox through a management scope or an administrative unit. Exchange's roles are added to any Entra consent, so the app must not also have Mail.Read, Mail.ReadBasic.All or Calendars.Read consented in Entra, or it could read every mailbox. Mail.ReadBasic leaves out each message's body, preview, attachments and extended properties, so they can't be read even by mistake. The client checks the roles claim of every token Microsoft issues and stops if it holds anything but Mail.ReadBasic, Mail.ReadBasic.All, Calendars.ReadBasic, Calendars.ReadBasic.All or Calendars.Read. Read-only is also enforced in code: besides the token request, the client sends only three GETs (the Inbox's and Sent Items' `messages/delta` and the mailbox's `calendarView/delta`), builds every parameter itself, and never fetches a paging link as given: it reads the skip or delta token out of each and builds the next request. Changes take Exchange from 30 minutes to 2 hours to apply; `Test-ServicePrincipalAuthorization` shows the mailbox in scope at once. The writes it may do later (`draft_reply`, `book_appointment`) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `MICROSOFT_TENANT_ID` | The directory (tenant) id, shared with OneDrive |
| `MICROSOFT_OUTLOOK_CLIENT_ID`, `MICROSOFT_OUTLOOK_CLIENT_SECRET` | The Outlook app's client id and a client secret. Its own app, apart from OneDrive's, since each holds only its own read permissions |
| `MICROSOFT_OUTLOOK_MAILBOX` | The address or object id of the one mailbox to read |
| `CORRESPONDENT_HASH_KEY` | The instance's key for correspondent references, shared with Gmail, so the same person is the same reference in both |

**What it reads.** Each of the three is a Graph delta. The historical import reads the Inbox and Sent Items from the start, filtered to messages received in the last five years, then the calendar view from five years back to a year ahead, 100 to a page, asking for immutable ids so a message keeps its id when it moves. Graph ends each listing with a delta token, which becomes its change feed, so each later sync asks only for what changed. Every page is one batch, and its checkpoint keeps Graph's token for each of the three. Graph's 410 Gone lists that one again. When the calendar's window ends within six months, the calendar is listed again with a window a year ahead; what it lists twice comes back as duplicates. 429s, 503s and 504s are retried, honouring Retry-After up to a minute.

**Events.** `communication.message_logged` keeps the message and thread references, the folder, direction (Sent Items is `sent`, the Inbox `received`), sent and delivered times, whether it has attachments, its importance, the sender and the To and Cc recipients as correspondent references (at most 50 each, with the full count). A message Graph says left a folder, by deletion or a move, is `communication.message_removed`. Drafts are skipped. `calendar.appointment_updated`, or `calendar.appointment_cancelled` once cancelled or deleted, keeps the appointment and series references, its kind (single, occurrence, exception or series), start and end in UTC, all-day, free or busy, whether it is online, the organizer and attendees as correspondent references with their responses, and its created and modified times. A message or event without an id or time that reads is dead-lettered listing why.

**Personal data.** Never kept: subjects, bodies, previews and attachments, an event's subject, body, location and meeting link (Graph sends them with every event and they often name a customer or a ring), categories, display names and every raw address. Each address becomes `correspondent:<hash>` exactly as Gmail's does, with its domain kept only for business domains. Graph's ids are kept as short digests.

**Push.** Graph can send change notifications for a mailbox, but a subscription needs a public endpoint and renewing every few days; it isn't built, and the scheduled sync reads the same deltas.

**Testing.** Until a test tenant is set up, the tests run against a mock built from Microsoft's docs (`packages/testkit/src/mocks/microsoft_outlook.ts`): the client credentials sign-in with a roles claim, the two folders' message delta with its `$select` and `$filter`, the calendar view's delta over its window, skip and delta tokens, `@removed` entries, 403 out of scope, 410 for expired tokens and 429 throttling. Microsoft's free developer tenant now goes only to Visual Studio subscribers, so a live check needs a paid Microsoft 365 tenant with a test mailbox holding only synthetic mail.

### Microsoft Teams

Reads one team's channel messages and replies through Microsoft Graph (v1.0), so the hand-offs about repairs, custom orders and sales that happen in Teams show up next to the rest of the business: who passes work to whom, in which channel and thread, and when. It never keeps a message's text, subject or attachments, a channel's name or anyone's display name.

**Permissions.** Make an app registration with no Microsoft Graph permissions in Entra at all, then a Teams app package whose manifest names its client id under `webApplicationInfo` and asks, under `authorization.permissions.resourceSpecific`, for the Application permissions `ChannelMessage.Read.Group` and `ChannelSettings.Read.Group` and nothing else. Upload it as a custom app in the Teams admin center and have an owner of the one team install it there. That resource-specific consent lets the app read that team's channels and messages and no other team, chat or mailbox in the tenant. The client checks the roles claim of every token Microsoft issues and stops if it holds anything but ChannelMessage.Read.All, ChannelSettings.Read.All or Channel.ReadBasic.All (tenant-wide reads an admin might have consented instead). Read-only is also enforced in code: besides the token request, the client sends only three GETs (the team's `channels`, each channel's `messages` with `$expand=replies`, and a thread's `replies`), builds every parameter itself, and never fetches a paging link as given: it reads the skip token out of each and builds the next request. The writes it may do later (`post_alert`, `post_daily_summary`) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `MICROSOFT_TENANT_ID` | The directory (tenant) id, shared with OneDrive and Outlook |
| `MICROSOFT_TEAMS_CLIENT_ID`, `MICROSOFT_TEAMS_CLIENT_SECRET` | The Teams app's client id and a client secret. Its own app, apart from OneDrive's and Outlook's, since each holds only its own read permissions |
| `MICROSOFT_TEAMS_TEAM_ID` | The group id of the one team the app is installed in |
| `CORRESPONDENT_HASH_KEY` | The instance's key for people references, shared with Gmail and Slack |

**What it reads.** Graph has no change feed for a team's channels that an app scoped to one team can read, so each sync lists the team's channels, then each channel's threads, 50 to a page, each with its replies. Graph sorts threads by their last change, the message or any reply, so a sync stops at the first thread that hasn't changed since the newest change the last sync read, less five minutes; the threads around that line come again as duplicates. The historical import reads back five years. A thread with more replies than the listing carries has the rest read from its own replies listing, up to 5,000. Every page is one batch, and its checkpoint keeps the channel being read, Graph's skip token and, for each channel, the newest change already read, so a resumed sync asks again from the page it was on. A channel added later is read from the start. 429s, 503s and 504s are retried, honouring Retry-After up to a minute.

**Events.** `communication.message_logged` keeps the channel, message and thread references, whether it is a reply, when it was posted and last edited, who posted it (`teams_user:<hash>` for a person, `teams_app:<hash>` for an app), its importance, and how many attachments, mentions and reactions it has. A message or reply Teams says was deleted is `communication.message_deleted`. Join, rename and other system notices are skipped. A message without an id or a time that reads is dead-lettered listing why.

**Personal data.** Never kept: message text (it is where customers' names, numbers and ring details turn up), subjects, summaries, attachments and their links, who was mentioned or reacted, channel names and descriptions, and every display name. A person becomes `teams_user:<hash>`, an HMAC-SHA256 of their Entra object id under `CORRESPONDENT_HASH_KEY`, so the same person is the same reference in every channel but can't be turned back into them. Channel and message ids are kept as short digests. Keeping redacted text for chosen channels, as Slack can, is a later step.

**Push.** Graph can send change notifications for channel messages, but a subscription needs a public endpoint, renewing within an hour and, for some uses, Microsoft's metered billing; it isn't built, and the scheduled sync lists the same messages.

**Testing.** Until a test tenant is set up, the tests run against a mock built from Microsoft's docs (`packages/testkit/src/mocks/microsoft_teams.ts`): the client credentials sign-in with a roles claim, the channels listing with `$select`, channel messages with `$top` and `$expand=replies` sorted by each thread's last change, a thread's replies, skip tokens, deleted messages, 403 for a team that didn't install the app and 429 throttling. A live check needs a paid Microsoft 365 tenant with a test team holding only synthetic messages. Whether Microsoft also requires its protected-API request form for `ChannelMessage.Read.Group` is checked on that first live run.

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

### NetSuite

Reads a wholesaler's or manufacturer's NetSuite account: items, vendors, sales and purchase orders, invoices, journal entries and stock by location, so finance, buying and inventory see the whole ERP next to retail and memo. Books arrive in the same `accounting.*` events the QuickBooks and Xero connectors give.

| Setting | What it is |
| --- | --- |
| `NETSUITE_ACCOUNT_ID` | The account id, such as `1234567` or `1234567_SB1` |
| `NETSUITE_CLIENT_ID` | The client id of the integration record made for KaratOS |
| `NETSUITE_CERTIFICATE_ID` | The certificate id NetSuite gives when the certificate is mapped |
| `NETSUITE_PRIVATE_KEY` | The certificate's private key, as PEM or base64-encoded PEM |

**Read-only by design.** The connector signs in by OAuth 2.0 machine-to-machine (client credentials): it signs a JWT with the certificate's private key and swaps it for an access token that lasts an hour. The token carries the permissions of the role the certificate is mapped to, so the setup asks the administrator for a role that can only view items, vendors, locations and the four kinds of transaction read, with REST Web Services and OAuth 2.0 log-in. It asks only for the `rest_webservices` scope, and sends only two requests to the account's SuiteTalk host: one for a token, and SuiteQL queries, which can only read. The five queries are fixed in the client with only bound parameters. Creating a sales order or a purchase order is declared behind the write gate, each needing approval, turned off, and the client has no request to send them. NetSuite blocks new token-based (TBA) integrations from 2027.1, so the connector doesn't use TBA.

**What it reads.** SuiteQL reads each list oldest change first, 1,000 rows a page by offset, and a query reads 100,000 rows at most. The first import reads every item and vendor, the transactions of the last six years (sales orders, purchase orders, customer invoices and journal entries), then stock by location. Each later sync reads what changed since the newest change the last one saw, less ten minutes, and stock by location again; the first later sync looks back three days. A pass that reaches 100,000 rows starts again from the newest change it saw. NetSuite writes times in the account's time zone, so the marks are kept as NetSuite wrote them, and a start worked out from KaratOS's clock reaches back a day further. A row read again unchanged is a duplicate. Each page is one batch, and the checkpoint keeps the list, its start, the next offset and the newest change seen.

**Events.**
- `accounting.item_updated` for each item: its sku, name, kind and whether it is active.
- `accounting.vendor_updated` for each vendor: its company name, currency and whether it is active. A vendor who is a person is named only by NetSuite id.
- `accounting.sales_order_updated`, `accounting.purchase_order_updated`, `accounting.invoice_updated` and `accounting.journal_entry_updated` for each transaction: its number, customer or vendor, date, due date, total and what is still owed in whole cents, currency and status.
- `inventory.counted` for each item at each location: on hand, available, committed, on order and back ordered.

Every event keeps the row's change time as NetSuite wrote it (`changedAt`) and is dated when it was read. A row without an id or a change time, a transaction of another kind, or stock on hand that isn't a count of zero or more is dead-lettered.

**Privacy.** No addresses, phone numbers, email addresses, memos or people's names are read: the queries don't select them.

**Rate limits.** NetSuite limits concurrent requests per account. The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 500, 502, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. A 400 or 401 on sign-in says the client id, certificate or key is wrong or the certificate has expired; a 403 on a query says the role can't view that list. A token turned down mid-sync is replaced once.

**Testing.** The tests run against a mock built from NetSuite's developer docs (`packages/testkit/src/mocks/netsuite.ts`). It checks each JWT's header, claims and signature against the certificate, the `Prefer: transient` header, the bound start, the page size and that every offset is a multiple of it. The first client's account must confirm: that the four transaction type codes and `aggregateitemlocation` columns read as the docs and community guides describe, the client id and certificate id shapes, and that times come back as `TO_CHAR` writes them.

### nFusion Solutions metals feed

Spot prices for gold, silver, platinum and palladium from nFusion Solutions' Market Data API at `https://api.nfusionsolutions.biz`, in US dollars per troy ounce, as the metals department's `metal.price_updated` events: the same shape the Metals-API connector gives, so either feed drives melt values for inventory and gold bought from the public, and the metals department's alert when a price moves. The connector was built from nFusion's OpenAPI spec ([apis.guru mirror](https://api.apis.guru/v2/specs/nfusionsolutions.biz/1/openapi.json)) and its [support page](https://nfusionsolutions.com/support/).

| Setting | What it is |
| --- | --- |
| `NFUSION_TOKEN` | The Market Data API token from the nFusion dashboard, under Connections, then API Keys |

**Access.** nFusion issues credentials under a service agreement, or through a [free trial](https://nfusionsolutions.com/free-trial/); there is no public pricing and no sandbox.

**Sign-in.** nFusion takes the token as the `token` query parameter. nFusion doesn't publish the token's format, so the connector accepts 8 to 256 letters, digits, `_` or `-`, and checks it before anything is sent. Because the token is in the URL, a request URL is never put in an error, a log or an error's cause, and any text nFusion sends back has the token, any `token=` pair and any URL masked before it is quoted. A 401, or a 403 that isn't the rate limit, stops the sync with a message naming `NFUSION_TOKEN`.

**What it reads.** Only two GETs, both with `currency=USD`, `unitofmeasure=toz` and `format=json`:

- `GET /api/v1/Metals/spot/history` with `metals=gold,silver,platinum,palladium`, `start`, `end` and `interval=1d`, for daily closes. The historical import reads five years ending yesterday, 90 days a request (21 requests). The checkpoint fixes the first and last day when the import starts and counts the requests already read, so a resumed import asks for exactly the same stretches. nFusion doesn't say whether `end` is kept, so each request asks through the day after its stretch and keeps only the stretch's days.
- `GET /api/v1/Metals/spot/summary` with the same metals, for the latest quote. Each incremental sync reads the daily closes from the last day it kept (the last 7 days the first time) through today, then the summary.

**Rate limits.** nFusion asks for fewer than one call a second per service, so requests are spaced at least 1.1 seconds apart. Its rate limit answers HTTP 403 with substatus 502. nFusion doesn't say how the substatus reaches the client, so a 403 whose body says `403.502` (as IIS writes it), or that names a substatus of 502 in its body or a header, is the rate limit. It, a 429, and a 500, 502, 503 or 504 are retried three times, honoring `Retry-After` up to a minute or else waiting 1, 2 and 4 seconds, before the sync stops and resumes from its checkpoint.

**Events.** Each price is `{ metal, spotPerTroyOunceCents, quote, priceDate }`. A daily close (`quote: "daily"`) is the interval's `last`, keyed by metal and day, and stands for the interval's end; a day not over yet is left for the next sync. A latest quote (`quote: "latest"`) is the summary's `last`, keyed by metal and nFusion's `timeStamp`. So a replay is a duplicate. nFusion also gives bid, ask, open, high and low, but the department's schema keeps only the metal and price, so they are left out. Each metal has its own `success` and `error` in the answer: a metal that failed, or isn't in USD per troy ounce, is dead-lettered with what was wrong, as is an interval or quote whose times or price don't read (under a cent or over a million dollars an ounce counts as not reading). A day with no close (`last` null) is skipped.

**Writes.** None: the API is GET-only market data, and the client has no way to send anything else.

**Testing.** There is no sandbox. The mock (`packages/testkit/src/mocks/nfusion.ts`) is built from the OpenAPI spec, and its assumptions list what the first live run with a token must confirm, among them the token's format, the `start` and `end` format, whether `end` is kept, and how the 403 substatus 502 shows.

### Nivoda

Reads the diamonds a saved Nivoda search finds, through the business's own Nivoda buyer account: grades, measurements and prices. Buying sees what can be sourced and at what price, and which stones were repriced or sold. Nivoda turns on API access by request, on its staging API first and on production after testing.

| Setting | What it is |
| --- | --- |
| `NIVODA_USERNAME` | The username of the account's API access |
| `NIVODA_PASSWORD` | The password that goes with it. It is sent only to Nivoda's two API addresses, which are fixed in the client, to sign in for a token |
| `NIVODA_ENVIRONMENT` | Optional. `production` or `staging`; `production` when unset |
| `NIVODA_QUERY` | Optional. The saved search as a JSON object in Nivoda's diamond query shape, such as `{"labgrown":false,"shapes":["ROUND"],"sizes":[{"from":1,"to":2}]}`. Every diamond Nivoda offers when unset, which `NIVODA_MAX_STONES` stops |
| `NIVODA_MAX_STONES` | Optional. The most diamonds the search may find before the sync stops and asks for a narrower search, 1,000 when unset and at most 50,000 |

**What it reads.** Each sync signs in for a token (Nivoda's last 6 hours; a new one is taken 10 minutes early, and once more if Nivoda turns one down), then reads every page of the search, 50 diamonds at a time, cheapest first, and compares the result with the last one read. Nivoda asks for 30 seconds between requests, so the client spaces every request itself: 1,000 diamonds take about ten minutes. A diamond that is new, or whose grades or price changed, is recorded; one that left the search is recorded as delisted, and one that comes back is recorded again.

Two guards keep a bad read from marking stones sold. An empty search when stones were known stops the sync instead. When the search changes while it is being read (Nivoda's count moves, or fewer diamonds arrive than it counted), the new and changed diamonds are kept but none is marked delisted until a sync reads the whole search; a diamond that moved across a page boundary and arrives twice is kept once.

Nivoda's errors stop the sync with Nivoda's message, with the password taken out. A 429 waits as Retry-After says, up to two minutes, three times.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `diamond_listing.listed` | A diamond new to the search or changed: Nivoda id, diamond id, Nivoda and supplier stock ids, natural or lab-grown, shape, carat weight, color, clarity, cut, polish, symmetry, lab and certificate number, total price and price per carat in cents, discount, measurements, depth and table, girdle, fluorescence, brown and green shade, milkiness, eye-clean, mine of origin, availability, and whether an image or video exists | Nivoda id and a hash of what was read, plus how often the diamond left the search before |
| `diamond_listing.delisted` | A diamond that left the search | Nivoda id and which departure this is |

A listing's time is when KaratOS saw it, since Nivoda doesn't say when a diamond was listed. Prices are read as whole US cents, so the account's API currency should stay US dollars (Nivoda changes it by request). Media links aren't stored: they point at supplier hosting. A result without a readable id, shape, carat weight or price is dead-lettered with its place in the search and what was wrong; the rest is still read. No department reasons over these events yet.

**Writes.** Declared and turned off: putting a diamond on hold and ordering one, which are Nivoda's Pro API mutations.

**Testing.** The tests run against a mock built from Nivoda's API help pages (`packages/testkit/src/mocks/nivoda.ts`), which signs in, pages a search and expires tokens with synthetic diamonds. The fields past Nivoda's installation guide are listed as the mock's assumptions and checked on the first staging run.

### Notion

Reads Notion's API (`https://api.notion.com/v1`, version `2026-03-11`) with an internal connection's secret: the data sources (database tables) shared with the connection, or the ones `NOTION_DATA_SOURCE_IDS` names, each one's properties, and its pages.

| Setting | What it is |
| --- | --- |
| `NOTION_ACCESS_TOKEN` | The secret of an internal connection with only the Read content capability and no user information, shared with only the databases to sync |
| `NOTION_DATA_SOURCE_IDS` | Optional. The data sources to read, by id, separated by commas; unset reads every data source shared with the connection |

**Read-only.** The client sends only three requests: `POST /search` for data sources, `GET /data_sources/{id}` and `POST /data_sources/{id}/query`. Search and query are POSTs in Notion's API, but both only read. Ids, page cursors and the edited-since time are checked before they go into a request, and the request bodies are built by the client. Notion's API can't report what a connection may do, so make it with the Read content capability only. Creating and changing a page are declared behind the write gate, and the test shows each one is stopped.

**What it reads.** Notion returns every property of a page when a query names none, so every query names its properties by id with `filter_properties`, and a data source with no readable property is kept for its structure only. Any property that comes back unasked is dropped. The properties read are those whose values hold no free text: number, checkbox, date, select, multi-select and status (their option labels), created and last edited time, relation (as page ids), people (as user ids) and unique id. Title, text, email, phone, URL, files, formula, rollup, created and edited by, verification, button and place properties are never asked for, and a page's own address, which holds its title, isn't kept. A data source with more than 100 readable properties has its first 100 read.

The first import reads pages edited in the last five years, 100 a page, oldest edit first. Each later sync asks only for pages edited since the last pass started, less five minutes of overlap. Each batch's checkpoint records the data source and the latest edit time read, so a resumed sync asks again from there, and pages already stored are duplicates; Notion's page cursors aren't kept. Notion stops one query at 10,000 pages, so the connector then asks again from the latest edit time read. A data source deleted or unshared part way through a pass is skipped, but one named in `NOTION_DATA_SOURCE_IDS` that isn't shared stops the sync saying so. A 429 is waited out for `Retry-After` seconds, up to a minute, three times, then left to `runSync`, which retries from the checkpoint. A 401 stops the sync saying the token was turned down; a 403 names the capability it needs. Notion doesn't report deleted pages to a query, so a deleted page is simply no longer read.

**Events.** The same vendor-neutral work-tracking events monday.com, Asana, Trello and Airtable send, so a department reads them all the same way.

| Event | From | Key |
| --- | --- | --- |
| `work.board_updated` | A data source: its name, its database as `notion:database:<id>`, whether it is in the trash, when it was made, and every property's id, type and name as columns, each marked with whether it is read | data source and a hash of what was read |
| `work.item_updated` | A page: its data source, when it was made and last edited, and its read property values | page and a hash of what was read |

Notion keeps edit times to the minute, so each version is keyed by a hash of what was read: a change is stored once and a replay is a duplicate. A record whose edit time doesn't read is dead-lettered.

**Webhooks.** None yet. The scheduled sync polls.

**Testing.** The tests run against a mock built from Notion's API reference (`packages/testkit/src/mocks/notion.ts`). Like Notion, it returns every property when none are named and only the named ones otherwise, so the tests show a title or text property never comes back. It answers 401 for the wrong token, 400 without the API version, 404 for a data source that isn't shared, applies the edited-since filter and sort, pages with `start_cursor`, stops a query at its result limit, and can answer 429. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, make a free Notion workspace for testing only, add a database or two of synthetic pages, make an internal connection with only Read content, share the databases with it, and add its secret as the `SANDBOX_NOTION_ACCESS_TOKEN` GitHub Actions secret.

### Quo (formerly OpenPhone)

Reads every call and text on a store's Quo lines. They arrive as the same `communication.call_logged` and `communication.message_logged` events the Twilio connector gives, so clienteling, repairs and sales see who called or wrote, and how fast the store answered, whichever phone system it uses.

| Setting | What it is |
| --- | --- |
| `QUO_API_KEY` | An API key from the Quo workspace's Workspace Settings > API |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** Quo issues one kind of API key and "each key has full access to your workspace's API", so the same key could send texts, change contacts or add webhooks. The client is what keeps KaratOS to reading. It sends only two requests, List calls (`GET /calls`) and List messages (`GET /messages`), to `https://api.quo.com`, with `Quo-Api-Version: 2026-03-30` and filters it builds itself from checked values. Sending a text and adding a contact note are declared behind the write gate, turned off, and the client has no request to send them.

**What it reads.** Quo lists calls and messages newest first by when they were created, 50 a page, with a cursor and no change-time filter. So a pass reads the calls and then the messages created in a span. The first import covers two years. Each later sync starts where the last pass started, less a day, because a call or text changes after it is created: it is answered, ends or is delivered. An unchanged one is a duplicate. The first later sync looks back two days. Each page is one batch, and the checkpoint keeps the span and Quo's cursor, so a resumed pass goes on from the page it reached. Quo can send webhooks, but the connector polls so it needs no public route.

**Events.**
- `communication.call_logged` for each call: the store's line (Quo's phone number id), inbound or outbound, status, whether an inbound call was missed (busy, not answered, cancelled, missed or abandoned), who answered (Quo's user id), duration, whether it was forwarded or handled by Quo's AI agent, and when it started, was answered and ended.
- `communication.message_logged` for each text: SMS or MMS, the conversation, line, direction, status, who sent it, how many attachments, how long the text was, and when it was sent and last changed.

Each event is keyed by a digest of what was kept. A call or text without an id, a time, a direction or a status Quo documents is dead-lettered.

**Privacy.** Calls and texts are the customer's own words, so no message text, media link, call summary, voicemail, recording or transcript is read into an event. Customers' numbers become the same customer references custom forms, Klaviyo and AvaTax make (an HMAC under `CUSTOMER_REF_KEY`), so one person lines up across systems without the number being kept. Withheld callers and short codes get no reference. Contacts aren't read: Quo's contact list carries names but no numbers, so it adds nothing a reference could link.

**Rate limits.** Quo allows 10 requests a second per key and answers 429 past it, without a `Retry-After` header. The client backs off (1, 2 and 4 seconds) on a 429, 500, 502, 503 or 504, honoring a `Retry-After` up to a minute if one comes, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 means the key is wrong or deleted. A 403 means the workspace can't use the API.

**Testing.** Quo has no sandbox. The tests run against a mock built from Quo's API reference (`packages/testkit/src/mocks/openphone.ts`). It checks the version header, the raw key, the filters each list takes and the page size. It lists what the first client's key must confirm: that a cursor stays good while the data it pages through changes, that a call or text's changes land within a day, and whether a 429 carries `Retry-After`.

### Pinterest

Reads one Pinterest business account's Pins and analytics through Pinterest's API (v5). Read-only two ways over: the connection holds `boards:read`, `pins:read` and `user_accounts:read` and nothing else, which the client checks on every token refresh before reading anything; and its only requests are the Pin list and two analytics reads for the connected account, with parameters it builds and checks itself.

| Setting | What it is |
| --- | --- |
| `PINTEREST_CLIENT_ID` | The App id of a Pinterest developer app the store owns |
| `PINTEREST_CLIENT_SECRET` | The same app's App secret key |
| `PINTEREST_REFRESH_TOKEN` | The business account's refresh token, with the three read scopes only |

**What it reads.** Every pass reads every Pin the account owns, 250 a page, with its title, the page it links to, its board and its 90-day and lifetime metrics. Then the account's daily impressions, saves, Pin clicks, outbound clicks and engagements: 90 days on the first import, which is as far back as Pinterest's analytics reach, and the last 30 days on each sync after, since Pinterest keeps refining recent days. Last, the 50 Pins saved most over the last 30 days, ranked.

**Events.** `social.pin_updated` for each Pin, `social.account_reported` for each day and `social.top_pin_reported` for each ranked Pin. Each is keyed by a digest of its numbers, so a revised day or Pin is stored as a new version and an unchanged one is a duplicate.

**Privacy.** Pins are the store's own posts and analytics are totals, so nothing names a customer. A Pin's description isn't kept, a title holding an @ is dropped, and a link keeps its address without the query string or fragment.

**Tokens.** Pinterest replaces the refresh token on every refresh (continuous refresh tokens, 60 days each). The newest is kept in the instance's database, sealed with a key derived from the client secret, so a daily sync keeps the connection alive indefinitely.

**Rate limits.** The client sends one request at a time and waits out a 429 (honoring `Retry-After` up to a minute, doubling from a second otherwise), three tries, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 renews the access token once. A 403 on analytics means the account isn't a business account.

**Writes.** Creating a Pin for a product, with its photo and a link to its page, is declared so it can be gated and audited, and is turned off. It needs a named person's approval. Turning it on would also need a token with `pins:write` and `boards:write`, which the connector stops on today.

**Testing.** The tests run against a mock built from Pinterest's OpenAPI description (`packages/testkit/src/mocks/pinterest.ts`), which checks the client credentials, the refresh token rotation, each token's scopes, the 90-day analytics window, page sizes, metrics and that a bookmark belongs to its list. Pinterest's sandbox doesn't serve analytics, so for the nightly run connect a test business account to a developer app with the three read scopes and add `SANDBOX_PINTEREST_CLIENT_ID`, `SANDBOX_PINTEREST_CLIENT_SECRET` and `SANDBOX_PINTEREST_REFRESH_TOKEN` as GitHub Actions secrets.

### PIRO

Reads PIRO's job and casting tree reports, exported as CSV into a folder, for jewelry manufacturers and wholesalers: where each job stands, and how much metal each casting tree took and gave back.

**How it reaches PIRO.** PIRO offers three routes:

- **Report exports.** Every account can export reports as CSV, by hand or as a scheduled data extract. This connector reads those.
- **EDI and XML** for exchanging documents with retail partners. PIRO's EDI documents (purchase orders, ship notices, invoices) are read by the [EDI X12](edi_x12.md) connector pointed at the folder PIRO writes them to, so they are not read twice.
- **A REST API** that PIRO offers for custom integrations it sets up. It is not public, so it would need PIRO's help and is not used yet.

| Setting | What it is |
| --- | --- |
| `PIRO_IMPORT_DIR` | The folder of report exports, outside any git repo |
| `PIRO_MAPPING_PROFILE` | Optional. `generic`, or the path to a profile JSON file in the client's private instance repo |

**Which files.** A profile's `files` patterns are tested against each CSV's name, casting first. The generic profile reads names with "cast" or "tree" as casting tree reports, and names with "job", "work order" or "manufactur" as job reports. Other files are skipped.

**Mapping profiles.** PIRO lets each account choose its report columns, so a profile names them. The generic profile reads the common names.

Job reports:

- **Required:** Job No (or Job Number, Job #, Job ID, Work Order) and Status.
- **Optional:**
  - Last Updated, Department (or Stage, Process), Style No, SKU and Order No
  - Metal, Karat and Qty
  - Start Date, Due Date and Completed Date
  - estimated and actual weights in grams or pennyweight, such as "Est Weight (g)" and "Actual Weight (dwt)"
  - Tree No

Casting tree reports:

- **Required:** Tree No, Cast Date, Metal, and the metal issued in grams or pennyweight, such as "Issued Weight (g)".
- **Optional:** Karat, Status, the weights returned, of the castings and of the scrap (button, sprues), and Jobs (separated by commas, semicolons or spaces).

Each weight unit has its own columns, so a weight is never read in a guessed unit. A value labeled with another unit ("12 g" in a pennyweight column) is a problem. A profile can also set the delimiter, the date order, the shop's UTC offset, and its own status labels.

**Statuses.** Each job's label is kept as `statusLabel` and mapped to a `status`. The profile's own labels are checked first, then the built-in words, top to bottom:

| Built-in words | Status |
| --- | --- |
| cancelled, canceled, void, scrapped | `cancelled` |
| on hold, hold, paused, waiting | `on_hold` |
| completed, finished, done, closed, shipped, delivered, invoiced | `completed` |
| not started | `open` |
| in progress, WIP, started, casting, setting, polishing, finishing, bench, filing, assembly, QC | `in_progress` |
| open, new, pending, issued, released | `open` |

Anything else is `other`.

**Events.**

- **`manufacturing.job_updated`.** A job, with its status, stage, style, SKU, order number, metal, karat, quantity, dates, estimated and actual weights in grams, the difference between them, and its tree. Customer names are never read; a job keeps only its order number. The key is `piro:job:<job number>:<hash of what the row says>`, so a report exported every day stores a job again only when something about it changed. Its time is the row's last update, then its completed or start date, then when the file was exported.
- **`manufacturing.casting_recorded`.** A casting tree, with the metal issued, castings, scrap and everything returned in grams (summed from castings and scrap when there's no total), `lossGrams` and `lossPercent`, and its jobs. It is keyed the same way, at its cast date.

A row with a problem (no job or tree number, a date or weight that can't be read, a metal that isn't exactly one metal, a karat outside 1 to 24) becomes an event with no time and a list of its problems, so the pipeline dead-letters it with the row kept. Rows older than five years are skipped. The checkpoint and resume work as for the POS connector: a file is read again only when its content changes.

**Testing.** Synthetic reports only:

- a job report with every status kind, rows with and without dates, unreadable rows, and a blank line
- a pennyweight casting report with and without a returned total, and trees with a weight in the wrong unit, an impossible date or an unknown metal
- a second day's export with one job changed
- a client profile with its own delimiter, date order, columns and status label

Column names are checked against a client's own export on the first account.

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

### Ramp

Reads a business's Ramp company card transactions, so finance sees each purchase with its spend category, GL account, receipt and approval state at month-end. Each arrives as a `card.transaction_updated` event.

| Setting | What it is |
| --- | --- |
| `RAMP_CLIENT_ID` | The client ID of a Ramp developer app made for KaratOS |
| `RAMP_CLIENT_SECRET` | That app's client secret |
| `RAMP_ENVIRONMENT` | Optional: `production` (the default) or `sandbox` |

**Read-only by design.** The app signs in with OAuth client credentials and asks for one scope, `transactions:read`. If Ramp grants the token any other scope, the connector doesn't use it. The client sends only GET requests to the transactions list, and follows Ramp's next-page links only while they point back at that list on the same host, so the token goes nowhere else. Adding a memo and coding a transaction are declared behind the write gate, turned off, and the app is never given a write scope. Ramp's own error text is never repeated in an error, only the HTTP status.

**What it reads.** The first import lists five years of transactions by when they were made, oldest first, 100 to a page. Each later sync lists the transactions Ramp says changed (`updated_after`) since a day before the last pass started, so a receipt, memo, category or settlement added since is read again. Each page is one batch and one checkpoint, which keeps Ramp's link to the next page. Tokens last ten days and are renewed before they run out, or at once if Ramp stops taking one.

**Events.** Each transaction has its ID, the amount in cents with whether money went out or came back, the currency, the amount the merchant charged when it was another currency, Ramp's state, the merchant's name and category code, Ramp's spend category, the GL account it's coded to, the cardholder's Ramp user ID with their department and location, whether it has a receipt and a memo, its policy violations, whether it's disputed, whether all its requirements are met and approved, the transaction a refund is for, and when it was made and settled. Each is keyed by a digest of what was kept, so an unchanged transaction is a duplicate and a new receipt is a new event. One without an ID, a time or an amount that reads is dead-lettered.

**Privacy.** A cardholder is kept as their Ramp user ID, never their name. A memo or receipt is kept as whether there is one, never its text or file.

**Rate limits.** Ramp allows 200 requests in 10 seconds. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time.

**Testing.** The tests run against a mock built from Ramp's docs (`packages/testkit/src/mocks/ramp.ts`). It checks the client credentials, the scope, the filters and paging, and lists what the first sandbox run must confirm: how the date filters match, and how `start` pages. For the nightly run, ask Ramp for a sandbox, make an app there with the client credentials grant and `transactions:read` only, and add its ID and secret as the `SANDBOX_RAMP_CLIENT_ID` and `SANDBOX_RAMP_CLIENT_SECRET` GitHub Actions secrets.

### RapNet and the Rapaport Price List

Reads the weekly Rapaport Price List for round and pear diamonds through Rapaport's Price List API, so buying, appraisals and wholesale price a stone against the same list. It needs a Rapaport subscription that includes the price list.

| Setting | What it is |
| --- | --- |
| `RAPNET_CLIENT_ID` | The client ID of a Rapaport Trade API access key made for KaratOS |
| `RAPNET_CLIENT_SECRET` | That key's client secret. It is sent only to Rapaport's token service, whose address is fixed in the client |

**What it reads.** Each sync signs in machine to machine, reads the Round and Pear lists, and stores a list it hasn't seen before, then the cells that moved in it. Rapaport publishes a new list each Thursday at 11:59 pm Eastern, so a daily sync picks it up the next morning; the other syncs that week read the two lists and stop. A token is renewed five minutes before it expires, and once more if Rapaport rejects it early. A 429 waits as Retry-After says, up to a minute, three times. A 403 stops the sync saying the subscription doesn't include the price list.

The client only sends GETs to the two price list endpoints. RapNet's Instant Inventory isn't read: Rapaport's terms forbid copying listings into another database, so network stones are for live searches, not syncs.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `diamond_price.list_published` | A shape's full list: every cell's carat range, color, clarity, price per carat in US dollars and the day it was priced, with the list's date (its newest cell) | shape, list date and a hash of the cells, so the same list read again is a duplicate and a corrected one is new |
| `diamond_price.list_changed` | The cells that moved in that list, each with its old price and date when Rapaport gives them, and how many rose and fell | the same |

Grades are read as Rapaport writes them, tidied for case and spacing; the grouped grades small sizes are priced in (`D-F`, `IF-VVS`) are kept as groups. A list with a cell that doesn't read is kept but dead-lettered, naming the rows that didn't read, so no price from it is used before a person looks. No department reasons over these events yet.

**Writes.** Declared and turned off: uploading the business's listings to RapNet, and sending a seller an inquiry.

**Testing.** The tests run against a mock built from RapTech's developer pages (`packages/testkit/src/mocks/rapnet.ts`), with made-up prices: the real list is copyrighted and for subscribers only, so no fixture comes near it. It is checked live once a subscriber's access key is connected.

### Refiner and scrap settlement statements

Reads the settlement statements a refiner sends after it melts and assays a lot of scrap, bench sweepings or old stock, as CSV exports or PDF statements, one folder per refiner. Each line becomes the lot, the metal, its weights in grams, the assay, the fine metal credited, and the money, for the metals department.

| Setting | What it is |
| --- | --- |
| `REFINER_STATEMENTS_IMPORT_DIR` | The folder of statements, outside any git repo. Inside it, one subfolder per refiner, named in lowercase letters, digits and underscores, such as `test_refinery`. Other folders are skipped |
| `REFINER_STATEMENTS_PROFILES` | Optional. `generic`, or the path to a JSON file in the client's private instance repo mapping refiner folders to parsing profiles or `"generic"`, with `"*"` for the rest |

**Parsing profiles.** A profile names the settlement date, lot and metal columns, and the weights: gross (as received), melt (after melting) and fine (pure metal credited), each in grams, pennyweight or troy ounces. Each unit has its own column (`fineGrams`, `fineDwt`, `fineOzt` and so on), so a weight is never read in a guessed unit, and a value labeled in another unit ("12.5 g" in a pennyweight column) is dead-lettered. It can also name the description, assay (`fineness`), price per ounce, credit, fee and net columns, the delimiter and the date order. A profile needs a fine weight column, or a weight and an assay to work it out from.

The generic profile reads:

- Settlement Date (or Date, Settled, Statement Date)
- Lot (or Lot Number, Lot #, Lot No, Reference, Ref)
- Metal (or Metal Type), and Description (or Material, Item)
- Gross, Melt and Fine weights as "Gross DWT", "Melt Grams", "Fine Oz", "Fine Weight (dwt)" and the like
- Assay (or Fineness, Purity, Assay %)
- Price (or Price per Oz, Metal Price, Spot)
- Credit (or Metal Value, Value, Gross Value, Amount)
- Fee (or Fees, Refining Fee, Charges, Treatment Charge)
- Net (or Net Amount, Net Value, Net Credit)

**Values.**

- **Weights** are stored in grams, to the milligram. A pennyweight is 1.55517384 g and a troy ounce 31.1034768 g.
- **Assay** reads as `58.5%`, `0.585`, `58.5`, `585` (parts per thousand) or `14K`. A bare 1 is pure.
- **Metal** reads from Gold, Silver, Platinum and Palladium, or Au, Ag, Pt and Pd. A line naming two metals is dead-lettered.
- **Money** is in cents. Fees are stored as money taken, however the statement signs them.

**What it reads.** Each CSV in a refiner's folder, in name order, refiners in name order. Title lines above the header are skipped: the header is the first line with the date, lot, metal and a weight. Rows with no date (subtotals, totals) are skipped, and lines older than five years too. The checkpoint and resume work as for bank statements: a file is read again only when its content changes.

**PDF statements.** Refiners lay out their PDFs too differently for one pattern to read them safely, so a PDF is read only for a refiner whose profile has a `pdf` layout. Without one, the sync stops with the file named and asks for a CSV export or a layout. A layout has:

- `line`: a regular expression, or a list tried in order, with named groups for the fields it shows (`date`, `lot`, `metal`, and weights such as `grossGrams`, `fineness` and `fineDwt`, then `credit` and so on).
- `ignore`: patterns for lines that aren't settlements, such as totals.

A PDF the layout matches nothing in stops the sync with the file named. PDFs are read with the same limits as bank statements: no forms, no fonts, and at most 20 MB and 300 pages.

**Events.** Each line becomes `refining.settlement_line_imported`. The payload has:

- `lineId`, which is `refiner:<refiner>:<lot>:<metal>:<n>`, where `n` counts that lot's earlier lines for the metal in the same file
- `refiner`, `lot`, `settledOn` and `metal`
- the weights in grams and the assay as a fraction (`fineness`)
- `fineGrams`, `fineTroyOunces`, and `fineFrom`, which is `statement`, or `assay` when it was worked out
- the price, credit, fee and net in cents, with `currency`
- `fineWeightCheck` and `expectedFineGrams`
- `sourceRow`

The key adds a hash of what the line says. So the same line in two exports, or in a CSV export and a PDF statement, is stored once, and a corrected statement for the lot is stored as its newer version. A line whose date, lot, metal or fine weight can't be read is keyed by where it is and dead-lettered with it kept.

**Checks.** `fineWeightCheck` is `matches` when the statement's fine weight is its melt weight (or gross weight, without a melt) times its assay, within half a percent or 10 milligrams. Otherwise it is `differs`. It is `not_checked` when the statement doesn't show both a weight and an assay, or when the fine weight was worked out from them.

The metals department raises two kinds of recommendation:

- When a lot is credited less fine metal than its assay says, it asks for a recheck.
- When a lot paid less than 90% of spot per fine ounce, against the spot price from the settlement day or the week before it, it suggests a second quote.

A later version of a lot replaces the earlier one in both checks.

**Testing.** Synthetic statements only:

- a pennyweight statement with a title block, a lot with gold and silver lines, a lot credited short, a fine weight worked out from the assay, and unreadable rows
- a grams statement with parts-per-thousand fineness
- an overlapping corrected export
- PDF statements written by the test with `syntheticPdf`: one read with a layout, one with no layout, and one the layout matches nothing in

Statements are the client's business records and never go in a repo.

### RepairShopr

Reads a repair shop's RepairShopr tickets, estimates and invoices, so each job can be followed from intake through its quote to the invoice and whether it was paid. Each arrives as a `repair.*` event.

| Setting | What it is |
| --- | --- |
| `REPAIRSHOPR_API_TOKEN` | A RepairShopr API token with only the Tickets, Estimates and Invoices List/Search permissions |
| `REPAIRSHOPR_SUBDOMAIN` | The account's subdomain, like `example` in `example.repairshopr.com` |

**Read-only by design.** A RepairShopr API token can be given custom permissions. Make one for KaratOS with only Tickets - List/Search, Estimates - List/Search and Invoices - List/Search, and no create, edit or delete permission. The client keeps to the reads as well: it sends only GET requests to those three lists, to the one account the settings name. Nothing is written back, so no write is declared. RepairShopr's own error text is never repeated in an error, only the HTTP status.

**What it reads.** A pass reads tickets, estimates and invoices, one list after another, a page at a time. The first import reads five years of tickets and invoices by when they last changed (`since_updated_at`), and the estimates made in that time (`created_after`). Each later sync reads the tickets and invoices changed since an hour before the last pass started. RepairShopr can't list estimates by when they changed, so each later sync reads again the estimates made in the 60 days before that, which catches a quote approved or declined in that time. Each page is one batch and one checkpoint, which keeps the list and the next page. A page count in the answer (`meta.total_pages`) says when a list ends; without one, an empty page does.

**Events.** A ticket has its number, status, customer, when it was opened and its due date. An estimate has its number, status, customer, date, subtotal, tax and total. An invoice has its number, customer, ticket, location, date, due date, subtotal, tax and total, and whether it's paid, verified paid or marked paid by a tech. Each is keyed by a digest of what was kept, so an unchanged record is a duplicate and a new status or payment is a new event. One without an ID or a time that reads is dead-lettered.

**Privacy.** A customer is kept as their RepairShopr ID, never their name, business name, email, phone or address. A ticket's subject and comments, and an invoice's note, PO number and PDF link, are not kept.

**Rate limits.** RepairShopr allows 180 requests a minute. The client waits out a 429 for as long as `Retry-After` says, up to a minute, or a full minute without one, and a 500, 502, 503 or 504 a few seconds, three times, before the error goes to the sync runner, which resumes from its checkpoint next time.

**Testing.** The tests run against a mock built from RepairShopr's docs (`packages/testkit/src/mocks/repairshopr.ts`). It checks the token, the time each list is read from and the paging, and lists what the first trial run must confirm: that the lists answer under their names with a page count, how the time parameters compare, and that pages keep a stable order.

### RFID and barcode tray counts

Reads the counts an RFID reader or barcode scanner takes of each tray and case, exported as CSV into a folder, so the inventory department can check each night's count against what should be there.

| Setting | What it is |
| --- | --- |
| `RFID_COUNTS_IMPORT_DIR` | The folder the reader software saves its count exports into, outside any git repo |
| `RFID_COUNTS_DATE_ORDER` | Optional. `mdy` (the default), `dmy` or `ymd` |
| `RFID_COUNTS_UTC_OFFSET` | Optional. The store's offset from UTC, such as `-05:00`, for scan times written without one. UTC when unset |

**The export.** One row per tag read, saved as CSV (or a `.txt` file in CSV form). Every such file in the folder is read. The columns it reads:

```text
Session ID,Tray,Tag,SKU,Scanned At,Staff,Status
```

- **Required:** Tray (or Case, Showcase, Location, Zone), Tag (the EPC, or the barcode on a barcode count; also Tag ID, EPC, RFID, Barcode), and Scanned At (also Scan Time, Read Time, Timestamp, Date).
- **Optional:**
  - Session ID, when the software numbers its counts. Without it, all of a tray's rows in one file are one count, so export one file per count or per night.
  - SKU, the stock number the tag is attached to, so a missing piece can be named and valued
  - Staff, the person who did the count, as a name or employee number
  - Status, when the software knows what belongs in the tray: Found (or OK, Scanned, Matched), Missing (or Not Found, Absent) and Unexpected (or Extra, Wrong Tray, Misplaced). Blank is found, so a plain read export works too. A missing row may leave the scan time blank, since the tag was never read.

**Events.** Each count becomes `inventory.tray_counted` with the tray, the session id when there is one, when the count started and ended, who did it, and the tags found, missing and in the wrong tray, each with its SKU when the export has one. A reader picks up a tag many times; it counts once, as unexpected if any read says so, else found if it was read at all. Its time is the last scan of the count, or the file's own time when nothing was read. The key is `rfid_counts:count:<tray>:<time>:<hash of what the count found>`, so the same export read again, or saved under another name, stores nothing new. A count split across two files reads as two counts.

A count with a row that can't be read (no tag, a tag that isn't an EPC or barcode, a status the connector doesn't know, a scan time that isn't a date or is blank on a piece that was read, a staff column with control characters) becomes an event with no time and the problems, line by line, so the pipeline dead-letters it with the rows kept: a count with a bad row would say the wrong thing. So does a count of more than 5,000 tags, and a row with no tray. Counts older than two years are skipped. The checkpoint and resume work as for the POS connector: a file is read again only when its content changes.

**What the inventory department does with it.** It looks at each tray's latest count. When pieces are missing it names up to five tags (with their SKUs) and says how many more, adds up what the store paid for those whose SKU it has seen received, and asks the store to check the safe, repair envelopes and pieces out on memo or approval before calling it a loss. Pieces read in the wrong tray are pointed out too. A piece missing one night and found the next drops off, because only the latest count of a tray counts.

**Testing.** Synthetic exports only: a count with found, missing and wrong-tray pieces, repeated reads, counts with and without session ids, a count where nothing was read, day-first dates and a store offset, unreadable rows, a blank line, an export saved again under another name, and resuming after a crash. The department tests cover a short count valued from receipts, a wrong-tray piece, and a later clean count clearing the reminder.

### RingCentral

Reads every call, text and voicemail on the store's RingCentral line (one extension). They arrive as the same `communication.call_logged` and `communication.message_logged` events Quo's and Twilio's give, so clienteling, repairs and sales see who called or wrote, and how fast the store answered, whichever phone system it uses.

| Setting | What it is |
| --- | --- |
| `RINGCENTRAL_CLIENT_ID` | The client id of the store's private KaratOS app, made for the JWT auth flow |
| `RINGCENTRAL_CLIENT_SECRET` | That app's client secret |
| `RINGCENTRAL_JWT` | A JWT credential made by the user whose extension is the store's line, allowed for that app only |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** The app is given only Read Call Log and Read Messages. Each sign-in's token says which permissions the app has, and the client stops before reading anything if one of them isn't a read permission (ReadCallLog, ReadMessages, ReadAccounts, ReadContacts or ReadPresence) or if the token doesn't say. It sends only three requests to `https://platform.ringcentral.com`: the JWT sign-in, the extension's call log and its message store, with parameters it builds itself from checked values and a page number, never from a link in an answer. Sending a text and placing a RingOut call are declared behind the write gate, turned off, and the client has no request to send them.

**What it reads.** A JWT signs in as one user, and the extension call log and message store are scoped to that user, so KaratOS reads only the store line's extension. RingCentral's sync APIs can't return more than 250 call records at a time, so they can't import history. So a pass lists the calls and then the texts and voicemail in a span, 250 a page. The first import covers two years. Each later sync starts where the last pass started, less a day, because a call ends after it starts and a text is read or a voicemail deleted after it arrives. An unchanged one is a duplicate. The first later sync looks back two days. Each page is one batch, and the checkpoint keeps the span, the step and the page, so a resumed pass goes on from the page it reached. The connector polls, so it needs no public route for webhooks.

**Events.**
- `communication.call_logged` for each call: voice or fax, inbound or outbound, RingCentral's action and result, whether an inbound call was missed (Missed, Voicemail, Rejected, Busy, No Answer, Hang Up, Abandoned or Declined), whether the caller withheld their number, duration, and when it started.
- `communication.message_logged` for each text or voicemail: the channel (`sms` or `voicemail`), the conversation, direction, status, whether it was read or deleted, how long a text was, how long a voicemail ran and whether it was transcribed, and when it arrived and last changed.

Each event is keyed by a digest of what was kept. A call or message without an id, a time, a direction or a result (for a call) or a text or voicemail type (for a message) is dead-lettered.

**Privacy.** Calls, texts and voicemail are the customer's own words, so no text, subject, voicemail audio, transcript or recording is read into an event, and caller names and locations are dropped. Customers' numbers become the same customer references Quo, custom forms, Klaviyo and AvaTax make (an HMAC under `CUSTOMER_REF_KEY`), so one person lines up across systems without the number being kept. Withheld callers and short codes get no reference.

**Rate limits.** The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. It signs in again once on a 401. A 403 names the permission the app is missing.

**Testing.** RingCentral's developer sandbox needs an account. The tests run against a mock built from RingCentral's developer guide (`packages/testkit/src/mocks/ringcentral.ts`). It checks the Basic auth and the JWT grant, the bearer token, the parameters each list takes and the page size. It lists what the first client's credential must confirm: that the token's scope is space-separated, that the call log pages like the message store, which results mean a missed call, and that changes land within a day.

### Search The Watch Market

Reads the market prices, days to sell and 13 weeks of price history for each watch reference the store follows, so the store sees a fair price and how fast a reference sells before it buys, takes a trade-in or prices a watch.

| Setting | What it is |
| --- | --- |
| `STWM_API_KEY` | The Business API key, from API Access in the store's account |
| `STWM_REFERENCES` | The references or names the store follows, comma or newline separated, up to 200 |

**Read-only by design.** The Business API only answers GETs. The connector sends four, with the key as a Bearer token: resolving a reference to its model group, the model's latest prices, its days to sell, and its weekly price history. It declares no writes.

**What it reads.** The API keeps no history past 13 weeks, so the historical import is one pass over the references and each later sync is another. Each reference is resolved to its model once, and the model is kept in the checkpoint, so later passes spend three calls on it. Two references for the same model are read once. Each reference is one batch, and the checkpoint keeps the pass's references, its day and its place, so a resumed sync goes on from there.

**Events.** `watch_market.price_observed` for each model each day it is read: the reference, brand, model number and name, the currency, the number of listings, the low, high and mean asking price, the market value, and the days half and 95% of listings take to sell. `watch_market.price_week` for each complete week of history: the low, high and mean in each currency quoted, and the number of listings. A reference that matches no model, and an answer that doesn't read, are dead-lettered.

**Allowance.** A plan allows 1,000 or 5,000 calls a day, shared with the vendor's own assistant access, and resets at midnight UTC. The client keeps the allowance left from `X-RateLimit-Remaining`, and a pass stops early, to go on next time, when 25 calls would be left. A 429 isn't retried, since it lasts until midnight; the sync runner keeps the checkpoint. A 500 or 503 is waited out 5, 10 and 20 seconds. Calls are spaced a quarter second apart.

**Testing.** The Business API needs a paid plan. The tests run against a mock built from the vendor's API reference (`packages/testkit/src/mocks/search_the_watch_market.ts`). It lists what the first client's key must confirm: the key's shape, that a week's date is its first day, and how a 429 answers.

### ShipStation

Reads the store's ShipStation shipments and labels: what shipped, how each parcel was insured next to what the customer paid, and its tracking until it arrives, so high-value parcels are watched until delivered and declared values match what was sold.

| Setting | What it is |
| --- | --- |
| `SHIPSTATION_API_KEY` | The account's API v2 key |

**Read-only by design.** ShipStation gives an account one kind of API key, and it has the account's full access: it could also buy labels, which spend the account's postage balance, and void them. ShipStation has no read-only key. So the client is what keeps KaratOS to reading: it sends only GETs of two lists to `https://api.shipstation.com/v2`, with the key in the `API-Key` header and parameters it builds itself from checked values. Buying a label and adding tracking to an order are declared behind the write gate, each needing approval, turned off, and the client has no request to send them.

**What it reads.** ShipStation lists shipments by when they last changed and labels by when they were made, oldest first, 100 a page by number, from a time. The first import reads both from two years back, shipments first. Each later sync reads the shipments changed since the newest change the last one saw, less five minutes, and the labels made in the last 30 days again, since a label's tracking status changes without the label being made again. The first later sync looks back two days for shipments. A record read again unchanged is a duplicate. Each page is one batch, and the checkpoint keeps the list, its start, the next page and the newest change seen, so a resumed sync goes on from that page.

**Events.**
- `shipment.updated` for each shipment: its status, carrier and service, the confirmation asked for and whether it needs a signature, the insurance provider, the insured value of its packages and what the customer paid, and how far the insured value falls short when both are in one currency; the order and shipment numbers, the store and order source, how many packages and items, the skus (up to 20), whether it is a return or a gift, the destination's state and country, and when it ships, was made and last changed.
- `shipment.tracked` for each label, the event the UPS connector gives: the tracking number and carrier, a status every carrier maps to (label created, in transit, delivered or exception), the label's own status and whether it was voided, the service, whether a signature was asked for, the label's and the insurance's cost, the insured value, whether it is a return or international, the destination's state and country, and when it ships and was made.

Each event is keyed by a digest of what was kept. A shipment without an id, a change time or a status, or a label without an id, a creation time or a status, is dead-lettered.

**Privacy.** Names, street addresses, postal codes, phone numbers, email addresses, buyer, gift and internal notes, and label images are never read into an event.

**Rate limits.** ShipStation allows 200 requests a minute. The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 500, 502, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 says the key is wrong or the plan has no API access; a 403 says the plan doesn't include that list.

**Testing.** API access depends on the account's plan. The tests run against a mock built from ShipStation's developer docs (`packages/testkit/src/mocks/shipstation.ts`). It checks the `API-Key` header, the parameters each list takes, the filters, the sort and the paging. It lists what the first client's key must confirm: that `page_size` goes to 100, how a label's tracking status moves, that amounts are in the currency's units, and the key's shape.

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

**Testing.** The tests use synthetic, doc-shaped responses until the nightly sandbox run has a development store. To set one up, create a free development store and an app with the read scopes above in the same Shopify Dev Dashboard organization, then add `SANDBOX_SHOPIFY_SHOP_DOMAIN`, `SANDBOX_SHOPIFY_CLIENT_ID` and `SANDBOX_SHOPIFY_CLIENT_SECRET` as GitHub Actions secrets. Until those exist, the nightly run lists Shopify as skipped. The writes it may do later (adjust inventory, tag customers and orders, create draft orders, change a variant's price, and create a single-use discount code for one customer) are declared, and the write-gate test shows each one is rejected.

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

### Smile.io

Reads the store's Smile.io loyalty program: each customer's points balance and VIP tier, and every points transaction, so staff see a customer's points and tier at the counter and marketing spots lapsed members early.

| Setting | What it is |
| --- | --- |
| `SMILE_API_KEY` | A merchant API key made with only `customer:read`, `points_transaction:read` and `vip_tier:read` |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** Smile scopes each merchant key, and a key with only read scopes can't add or take away points. Smile has no call that lists a key's scopes, so the setup asks for those three read scopes and nothing else, and the client sends only GET requests to `https://api.smile.io/v1`: List VIP tiers, List customers (with their VIP status) and List points transactions, with parameters it builds itself from checked values and Smile's page cursor, never from a link in an answer. Adjusting a customer's points is declared behind the write gate, needing approval, turned off, and the client has no request to send it. Merchant keys need Smile's Plus or Enterprise plan.

**What it reads.** Smile lists customers and points transactions newest first, 250 a page, and can filter them to those changed since a time. The first import reads everything changed in the last five years, customers first. Each later sync reads what changed since the newest change the last one saw, less five minutes; the first later sync looks back two days. An unchanged record read again is a duplicate. Each sync reads the VIP tiers first, to name each customer's tier. Each page is one batch, and the checkpoint keeps the list, its start, the newest change seen and Smile's cursor, so a resumed sync goes on from that page.

**Events.**
- `loyalty.customer_updated` for each customer, as Yotpo's are: their program state (candidate, member or disabled), points balance, VIP tier and its id, when the tier ends, their progress in the current period and when it ends, how much more keeps the tier, the next tier and how much more reaches it, and when they joined and last changed.
- `loyalty.points_changed` for each points transaction: the customer, the points added or taken away, whether they were earned or spent, and when.

Each event is keyed by a digest of what was kept. A customer without an id, a creation time, a state or a points balance, or a transaction without an id, a customer, a points change or a time, is dead-lettered.

**Privacy.** Names, birthdays, referral links, and a transaction's description and internal note are never read into an event. Customers' emails become the same customer references custom forms, Klaviyo, Quo and Yotpo make (an HMAC under `CUSTOMER_REF_KEY`).

**Referrals.** Smile's API has a referral object but no call that lists referrals, so they aren't read.

**Rate limits.** Each key gets 10 requests a second. The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 500 or 503, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 says the key is wrong or the plan lost API access; a 403 names the scope the key is missing.

**Testing.** Merchant keys need a paid plan. The tests run against a mock built from Smile's developer docs (`packages/testkit/src/mocks/smile_io.ts`). It checks the bearer key, each list's scope, the parameters each list takes, the sort and the page size. It lists what the first client's key must confirm: that a read-only key can't write, that `updated_at_min` holds across pages, that points and tier changes move `updated_at`, and the time format.

### Sola Payments

Reads the card and check payments and refunds that go through a store's Sola Payments gateway (formerly Cardknox), so finance can reconcile them, layaway installments included, against sales and deposits. Payments arrive as the same `payment.charge_updated` and `payment.refund_updated` events the Stripe and Authorize.net connectors give.

| Setting | What it is |
| --- | --- |
| `SOLA_API_KEY` | An API key from the Sola Portal's key management |
| `SOLA_TIME_ZONE` | Optional: the time zone Sola's report times are in, defaulting to `America/New_York` |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** Sola's API keys can run sales and refunds as well as reports, and Sola documents no way to limit one to reports. The client is what keeps KaratOS to reading. It posts only to Sola's reporting address (`x1.cardknox.com/reportjson`), never the gateway that moves money, and only the one command `Report:All`, with dates built from checked values. Creating payment links and recurring schedules for layaways are declared behind the write gate, turned off, and the client has no request to send them. Sola's own error text is never repeated in an error, only its code.

**What it reads.** The transaction report a month at a time, oldest first, 1,000 rows to a page. Past a full page, the next request starts at the last row's time. The first import covers five years. Each later sync covers from two days before the last pass, by day. Each page is one batch and one checkpoint.

**Events.** `payment.charge_updated` for sales, captures, post-auths, authorizations and check sales, and `payment.refund_updated` for refunds and credits. Each has the reference number, amount in cents, currency, status (succeeded, pending for an authorization, or failed for a decline, error or void), Sola's command and result, whether it was voided, card or ACH, the card brand, the batch, and the customer references. Saves, balance checks and gift card commands aren't payments, so they are skipped. Each is keyed by a digest of what was kept, so an unchanged row is a duplicate and a void is a new event. A row without a reference number, a command, a time or an amount that reads is dead-lettered.

**Privacy.** A card is kept as its brand only: no masked number, token, name, address, invoice or description. The customer's email address and phone number only make keyed customer references.

**Rate limits.** Sola doesn't document one. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time.

**Testing.** The tests run against a mock built from Sola's docs (`packages/testkit/src/mocks/sola_payments.ts`). It checks the key, the command, the dates and paging, and lists what the first sandbox run must confirm: the report rows' field names, the time zone of report times, and whether the dates are inclusive. For the nightly run, sign up for a free Sola sandbox account (solapayments.com/devsdk), run a few test-card sales with synthetic customers (`@example.test` addresses), create an API key, and add it as the `SANDBOX_SOLA_PAYMENTS_API_KEY` GitHub Actions secret.

### Square

Reads the Square API on `connect.squareup.com` (or `connect.squareupsandbox.com`), pinned to API version 2026-09-16 with the `Square-Version` header. Read-only is enforced twice. Before its first read, and after every token refresh, the client asks Square which scopes the token holds (`POST /oauth2/token/status`) and stops unless they are exactly the six read scopes below, naming any extra or missing one. A personal access token from the Developer Console has full access to the account, so the connector stops with one. The client also sends requests to eight read endpoints only, each with its own method, path and parameters, and anything else is stopped before it leaves the server: `GET /v2/locations`, `POST /v2/catalog/search`, `POST /v2/catalog/batch-retrieve`, `POST /v2/inventory/counts/batch-retrieve`, `POST /v2/customers/search`, `POST /v2/orders/search`, `GET /v2/payments` and `GET /v2/refunds`. The writes it may do later (adjust inventory, update catalog items) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `SQUARE_APPLICATION_ID`, `SQUARE_APPLICATION_SECRET` | The KaratOS app's credentials from developer.squareup.com: the Sandbox tab for a sandbox seller, Production for a store |
| `SQUARE_REFRESH_TOKEN` | The refresh token from the seller authorizing the app (the OAuth code flow) |
| `SQUARE_ACCESS_TOKEN` | Instead of the three above, for a short test only: an OAuth access token already limited to the read scopes. It lasts 30 days and isn't refreshed |
| `SQUARE_ENVIRONMENT` | Optional. `production` (the default) or `sandbox` |
| `CUSTOMER_REF_KEY` | Keys the customer references (below). Generated by `npm run secrets:setup`; never rotated |
| `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL` | Optional. The webhook subscription's signature key and its notification URL exactly as set, for when webhooks are turned on |

**Scopes.** Authorize with exactly `MERCHANT_PROFILE_READ ITEMS_READ INVENTORY_READ CUSTOMERS_READ ORDERS_READ PAYMENTS_READ`. Every refresh asks for these scopes only, and Square limits the new token to them, so even an authorization that once included more yields a read-only token. Access tokens last 30 days and are refreshed a day early, one refresh at a time; Square returns the same refresh token each time, so nothing needs saving.

**What it reads.** In order: the catalog's items with their variations (deleted and archived ones too), the current in-stock counts at every location, customers, orders, payments and refunds. The historical import reads the whole catalog and every count, and five years of customers, orders, payments and refunds. Orders are searched ten locations at a time and payments read per location, since Square lists only the main location's payments unless told otherwise; inactive locations are read too. Payments and refunds are always filtered from five years back on creation, as Square otherwise looks back only a year. Incremental passes read what changed since the previous pass started, less five minutes; with no checkpoint the first pass looks back 48 hours. The checkpoint keeps the stream, the location and Square's page cursor, so a crash resumes at the next page.

**SKUs.** Order lines and counts name a catalog variation, not its SKU. The connector uses the SKUs the catalog stream gave it and asks the catalog (`batch-retrieve`, deleted objects included) for any variation it hasn't seen this run, so a Square sale carries the same SKU as the same ring sold on Shopify or in a POS export. A variation without a SKU becomes `square-variation-<id>`, and an amount rung up without a catalog item `square-line-<order>-<line>`.

**Events.** The same types and shapes as the connectors already built. Orders give `order.updated` (Shopify's shape), `sale.completed` once completed, with one payment per tender (card, cash, gift card, financing, wire or other), and `sale.returned` for each return in a return order, against the original sale. Payments and refunds give `payment.charge_updated` and `payment.refund_updated` (Stripe's shape). Items give `product.updated` (Shopify's shape), with each variation's SKU and price. Counts give `inventory.counted` per location (the POS connector's shape); a fractional or negative count is dead-lettered. Customers give `customer.profile_updated` with marketing consent off, since Square records only unsubscribes. Each event is keyed by record and `updated_at` (a sale by its order alone), so a replay is a duplicate.

**Privacy.** A customer becomes `square:customer:<hmac>`, an HMAC-SHA256 of Square's customer ID keyed with `CUSTOMER_REF_KEY`, the key custom form submissions use for theirs; the profile's name is a label made from that reference. No names, email addresses, phone numbers, addresses, birthdays, notes, ticket names, receipt links or refund reasons are kept, and of a card only its brand: never the last four digits, expiry, BIN or fingerprint.

**Rate limits.** Square limits requests per application and answers 429 `RATE_LIMITED`. The client waits with exponential backoff and jitter (1, 2 and 4 seconds, or `Retry-After` up to a minute when sent), then hands the error to `runSync`, and the next run resumes from the checkpoint.

**Webhooks.** `verifySquareWebhook` checks `x-square-hmacsha256-signature`, the base64 HMAC-SHA256, keyed with the subscription's signature key, of the notification URL followed by the raw body, compared in constant time. Square signs no timestamp, so a captured delivery stays valid: `SquareReplayGuard` handles each `event_id` once within 25 hours (Square retries for 24), and the event keys, the same ones the sync uses, stop a replay from storing anything twice after a restart. Payment, refund and customer notifications become events (`handleWebhook`); order, inventory and catalog ones only name what changed, so they are a prompt to sync. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** Until a Square developer account is set up, the tests run against a mock built from Square's docs (`packages/testkit/src/mocks/square.ts`), which refreshes tokens with the documented scope intersection, reports each token's scopes, answers 401 without a valid token and 403 without the scope, ties each cursor to its query, and enforces the documented limits and defaults. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, create a free Square developer account, open its sandbox seller, authorize the app on the sandbox with the read scopes above, and add `SANDBOX_SQUARE_APPLICATION_ID`, `SANDBOX_SQUARE_APPLICATION_SECRET` and `SANDBOX_SQUARE_REFRESH_TOKEN` as GitHub Actions secrets.

### Squarespace Commerce

Reads a Squarespace store's products, stock and orders through its Commerce APIs (Products v2, Inventory 1.0 and Orders 1.0). Read-only two ways over: the API key is made with Read Only permission for Orders, Inventory and Products, which Squarespace lets each API have, and the client sends only GET requests for those three lists.

| Setting | What it is |
| --- | --- |
| `SQUARESPACE_API_KEY` | A key with Read Only permission for Orders, Inventory and Products, from Settings, Advanced, Developer API Keys (Commerce Advanced plan) |
| `CUSTOMER_REF_KEY` | Shared: the key customer references are made with |

**What it reads.** Every pass reads the whole catalog, then every stock line, then the orders modified in its window, 50 a page. The historical import's window reaches back five years. Each later sync's starts a day before the last one ended. A pass reads orders modified up to a time fixed when it starts, and keeps each page's cursor in its checkpoint, so a stopped sync resumes there.

**Events.** A product becomes `product.updated` (type, name, whether it is on sale on the site, and each variant's SKU, price, sale price and stock). A stock line becomes `inventory.counted` (SKU and quantity, null when stock isn't tracked), dated when it was read. An order becomes `order.updated` (number, channel, fulfillment and payment states, test mode, money in cents, lines with product, variant, SKU, quantity and unit price, and the customer). Each is keyed by its record and a digest of what was kept, so one read again unchanged is a duplicate. A record without an ID or a time that reads is dead-lettered.

**Privacy.** Only a reference keyed with `CUSTOMER_REF_KEY` is kept for a customer. Emails, names, addresses, phone numbers, line customizations (they can hold an engraving), form answers and internal notes aren't kept.

**Rate limits.** Squarespace allows 300 requests a minute and answers 429 for a minute's cool-down past that. The client waits out a 429 (Retry-After if given, otherwise a minute) and a 5xx (longer each time) three times before the error goes to runSync, which keeps the checkpoint.

**Writes.** Setting a variant's stock and fulfilling an order are declared, each needing approval, and turned off. The key has no write permission, so they can't run until a key with it is made.

**Testing.** The tests run against a mock built from Squarespace's reference (`packages/testkit/src/mocks/squarespace.ts`). It checks the key, its permissions, the User-Agent, cursors and the modified window. Its assumptions are listed so the first run against a paid site can confirm them.

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

### Stuller

Reads the invoices on the business's Stuller account and Stuller's current metal market rates. Buying and finance see what was ordered, what it cost, what is still owed and where each shipment is, and the metal prices the invoices were priced at. It needs a Stuller account and a developer login, which a Stuller account owner makes under the Developer role; that login works with the API only and can't sign in to Stuller.com.

| Setting | What it is |
| --- | --- |
| `STULLER_USERNAME` | The developer login's user name |
| `STULLER_PASSWORD` | The developer login's password. It is sent only to `api.stuller.com`, which is fixed in the client |

**What it reads.** Each sync reads every invoice from `GET /api/v2/invoice`, since that endpoint has no date filter, and records the ones that are new or changed since the last sync, oldest first. Invoices dated more than five years back are skipped. It then reads `GET /api/v2/products/metalmarketrates`. A login Stuller turns down (HTTP 401) stops the sync and says to check the login and its Developer role. A 429 waits as Retry-After says, up to a minute, three times.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `vendor_invoice.received` | An invoice new or changed: invoice, order and purchase order numbers, ship-to account number, status, invoice and order dates, order, invoice and due totals, sales tax and shipping in cents, ship method, tracking number, the gold, silver and platinum rates it was priced at, and each line's item number, description, quantities shipped and back-ordered, unit price, line total, labor and other charges, and weight | invoice number and a hash of what was read |
| `vendor_metal_rate.published` | Stuller's current price per troy ounce in cents for gold, silver, platinum and palladium | a hash of the rates |

An invoice is recorded again when its status, tracking or anything else read changes, so a shipment can be followed from order to delivery; unchanged invoices and unchanged rates are not recorded twice. The rates' time is when KaratOS read them, since Stuller's answer carries none. Ship-to addresses and tracking links aren't stored: a drop-shipped order carries the business's customer's address. An invoice without a readable number or date, or with an amount or line that doesn't read, is dead-lettered listing what was wrong; the rest are still read. No department reasons over these events yet.

**Writes.** Declared and turned off: submitting an order to Stuller.

**Testing.** The tests run against a mock built from Stuller's API help pages (`packages/testkit/src/mocks/stuller.ts`), which answers synthetic invoices and rates and turns down a wrong login. It is checked live once a developer login is connected.

### Supplier invoices and memos

Reads the invoices and memos a store or workshop gets from its suppliers, as CSV exports, one folder per supplier. Each line becomes the document, the item, its quantity and cost, and whether it is a natural or lab-grown diamond, with what the document says about where its diamonds came from. Memo lines also go to the memo reminder, so goods on memo are paid for or sent back on time.

| Setting | What it is |
| --- | --- |
| `SUPPLIER_INVOICES_IMPORT_DIR` | The folder of exports, outside any git repo. Inside it, one subfolder per supplier, named in lowercase letters, digits and underscores, such as `test_supplier`. Other folders are skipped |
| `SUPPLIER_INVOICES_PROFILES` | Optional. `generic`, or the path to a JSON file in the client's private instance repo mapping supplier folders to parsing profiles or `"generic"`, with `"*"` for the rest |

**Parsing profiles.** A profile names the document number and date columns, and a line amount or unit cost column. It can also name the document type, item (`sku`), description, stone, quantity, due date, terms and statement columns, the delimiter and the date order.

The generic profile reads:

- Invoice (or Invoice Number, Invoice No, Invoice #, Memo, Memo Number, Memo No, Memo #, Document, Document Number, Doc #)
- Date (or Invoice Date, Memo Date, Document Date)
- Type (or Document Type, Doc Type, Transaction Type)
- SKU (or Style, Style #, Style Number, Item #, Item Number, Stock #, Stock Number), Description (or Item Description, Details) and Stone (or Stone Type, Center Stone, Gem)
- Qty (or Quantity, Pcs, Pieces, Units)
- Unit Price (or Unit Cost, Price, Cost, Price Each) and Amount (or Extended, Ext Price, Extended Price, Line Total, Total)
- Due Back (or Return By, Memo Due, Memo Due Date, Due Date) and Terms (or Memo Terms, Payment Terms)
- Statement (or Warranty, Warranty Statement, Notes, Remarks, Comments)

**Values.**

- **Type** reads Memo, Memorandum, Consignment, Consigned or On Memo as a memo, and Invoice, Inv, Sale, Sales Invoice, Bill or Purchase as an invoice. Anything else, such as a credit note, is dead-lettered. Without a type column, a file whose name says memo or consignment holds memos, and any other holds invoices.
- **Money** is in cents. A line without an amount is its quantity (1 when there is no quantity column) times its unit cost.
- **Due dates** come from the due column. Without one, terms such as "Net 30", "30 days" or "30 day memo" count that many days from the document's date. For a memo it is the date the goods go back by; for an invoice, the date it is due.
- **Diamonds.** A line whose stone or description says diamond is a natural diamond, unless it also says lab-grown, lab-created, laboratory-grown, LGD, synthetic, man-made, CVD, HPHT or cultured. "Diamond-cut", "diamond-shaped" and similar metal finishes, and simulated or imitation diamonds, are not diamonds.

**Statements.** Each document's text is searched for the World Diamond Council's System of Warranties statement. The current wording reads: "The diamonds herein invoiced have been purchased from legitimate sources not involved in funding conflict, in compliance with United Nations Resolutions and corresponding national laws. The seller hereby guarantees that these diamonds are conflict free and confirms adherence to the WDC SoW Guidelines." A document carries it when its text has "not involved in funding conflict", "guarantees that these diamonds are conflict free", "System of Warranties" or "WDC SoW". It is `current` when it names the WDC SoW Guidelines, and `earlier` otherwise. The text is every cell of the document's rows. When a file holds one document, it also includes the lines above the header and rows without a document number, where a printed statement usually sits. `kimberleyProcess` says whether the text names the Kimberley Process.

**What it reads.** Each CSV in a supplier's folder, in name order, suppliers in name order. Title lines above the header are skipped: the header is the first line with the document number, the date and a money column. A row with a document number and an item, unit cost or amount is a line. A row with only words, such as a statement printed under the lines, counts toward its document's text. Documents older than six years are skipped. The checkpoint and resume work as for bank statements: a file is read again only when its content changes.

**Events.** Each line becomes `supplier_invoice.line_imported`. The payload has:

- `lineId`, which is `supplier:<supplier>:<type>:<number>:<n>`, where `n` counts the document's earlier lines in the same file
- `supplier`, `documentType`, `documentNumber` and `documentDate`
- `sku`, `description`, `stone`, `quantity`, `unitCostCents`, `amountCents`, `due` and `terms`, when the line has them
- `diamond` (`natural`, `lab_grown` or `none`), `warrantyStatement` (`current`, `earlier` or `none`) and `kimberleyProcess`
- `currency` and `sourceRow`

A memo line with an item, an amount above zero and a due date also becomes `memo.received`, with the memo id `<supplier>/<number>/<n + 1>`, since memo numbers repeat between suppliers.

The key adds a hash of what the line says, so the same line in two exports is stored once, and a corrected document is stored as its newer version. A line whose date, type or amount can't be read is keyed by where it is and dead-lettered with it kept.

**Checks.**

- The buying department's memo reminder follows each memo line from 14 days before it is due back. It says whether the item has sold, so the memo is paid for or the goods go back.
- The compliance department checks each invoice and memo from the last 90 days that lists a natural diamond. When no System of Warranties statement was found anywhere on the document, it suggests asking the supplier for a copy that carries it. It is a reminder, not legal advice. A statement printed only on a paper or PDF copy isn't in the CSV, so the reminder says no statement was found, not that none exists.

**Not yet read.** PDF invoices and memos, and memo returns and purchases (`memo.settled`), are a follow-up.

**Testing.** Synthetic exports only:

- an invoice export with a title block, a statement printed under the lines, natural, lab-grown and diamond-cut lines, and unreadable rows
- a memo export with terms instead of due dates and two documents in one file
- an overlapping corrected export

Invoices and memos are the client's business records and never go in a repo.

### TaxJar

Reads the sales tax on the sales and refunds a store records in TaxJar, and the states and countries it has nexus in. Transactions arrive as the same `tax.transaction_updated` events the Avalara AvaTax connector gives, so finance and compliance read tax from either the same way.

| Setting | What it is |
| --- | --- |
| `TAXJAR_API_TOKEN` | The business's TaxJar API token, from Account > TaxJar API |
| `TAXJAR_ENVIRONMENT` | Optional: `production` (the default) or `sandbox` |
| `TAXJAR_PROVIDERS` | Optional: where transactions were recorded, comma-separated, such as `api,shopify`; `api` when empty |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** TaxJar issues one kind of API token and it can't be limited to reading, so the same token could record, change or delete transactions. The client is what keeps KaratOS to reading: its only requests are five GETs (list and show order transactions, list and show refund transactions, and list nexus regions), to TaxJar's fixed production or sandbox address, with paths and filters built from checked values. Recording a sale or a refund is declared behind the write gate, turned off, and the client has no request to send it.

**What it reads.** TaxJar lists transactions as ids, by the day they were recorded (`from_transaction_date` and `to_transaction_date`), for one source at a time (`provider`, which TaxJar takes as `api` when none is named). So a pass walks each provider's orders and then its refunds through the days in spans of 31, reads each listed transaction (`x-api-version: 2022-01-24`), and ends by reading the nexus regions. The first import covers five years. TaxJar keeps no change time, so each later sync reads the last 31 days again: a transaction recorded late with an earlier day, or changed, is picked up, and an unchanged one is a duplicate. Each 100 transactions read are one batch and one checkpoint, so a resumed pass goes on from the span and place it reached. A transaction deleted between the list and the read is skipped.

**Events.** `tax.transaction_updated` for each sale or refund, with its kind (sale or return), provider, the order a refund refunds, its day, the amount, shipping and sales tax in cents, its exemption (wholesale, government, marketplace or other), the state and country it was shipped from and to, and up to 200 lines by SKU and tax code with their price, discount and tax. Each is keyed by a digest of what was kept. `tax.nexus_updated` lists the nexus regions, keyed the same way, so an unchanged list is a duplicate. A transaction without an id, a day, an amount or a sales tax that reads is dead-lettered.

**Privacy.** A transaction can name the customer, so the ship-to street, city and ZIP code and the line descriptions aren't kept, and the customer id becomes a keyed reference. The ship-from state, city and ZIP code are the store's own and are kept, since sourcing rules tax by them.

**Rate limits.** The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 means the token is wrong or for the other environment, and a 403 that the account can't use the API.

**Testing.** TaxJar gives API tokens to paid accounts only, so the tests run against a mock built from TaxJar's API reference and its official SDKs' documented examples (`packages/testkit/src/mocks/taxjar.ts`). It checks the token, the date format and the provider, and lists what the first client's token must confirm: that both list dates are included, the shape of an error body, and that transactions from a platform integration are listed under that platform's provider name.

### TikTok

Reads the store's own TikTok account through TikTok's Display API (v2). Read-only two ways over: the connection holds `user.info.basic`, `user.info.stats` and `video.list` and nothing else, which the client checks on every token refresh before reading anything; and its only requests are the profile read and the video list, with fields and a page cursor it builds and checks itself.

| Setting | What it is |
| --- | --- |
| `TIKTOK_CLIENT_KEY` | The client key of a TikTok for Developers app the store owns |
| `TIKTOK_CLIENT_SECRET` | The same app's client secret |
| `TIKTOK_REFRESH_TOKEN` | The store account's refresh token, with the three read scopes only |

**What it reads.** Each pass reads the account's followers, accounts followed, total likes and video count, then its public videos, newest first, 20 a page: on the first import every video posted in the last two years, and on each sync after, the videos of the last 90 days again, since their views and likes are still moving. Each video comes with its title, its share link, how long it runs and its views, likes, comments and shares.

**Events.** `social.account_reported` for the account's counts on the day read and `social.video_updated` for each video. Each is keyed by a digest of its numbers, so a video whose counts moved is stored as a new version and an unchanged one is a duplicate.

**Privacy.** Videos are the store's own posts and the counts are totals, so nothing names a customer. A video's description isn't asked for, a title holding an @ is dropped, and a link keeps only a tiktok.com address without its query string.

**Tokens.** Access tokens last a day. TikTok may answer a new refresh token on a refresh, and the newest is kept in the instance's database, sealed with a key derived from the client secret. A refresh token lasts a year from when the account signed in, so the account signs in again once a year.

**Rate limits.** The client sends one request at a time and waits out a 429 (honoring `Retry-After` up to a minute if TikTok sends one, doubling from a second otherwise), three tries, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 renews the access token once, except when TikTok says a scope was never allowed. An error code other than `ok` in an answer is treated as an error, whatever the HTTP status.

**Writes.** Posting a product video is declared so it can be gated and audited, and is turned off. It needs a named person's approval. Turning it on would also need a token with `video.publish`, which the connector stops on today.

**Testing.** The tests run against a mock built from TikTok for Developers' Display API docs (`packages/testkit/src/mocks/tiktok.ts`), which checks the client credentials in the form, the refresh token rotation, each token's scopes and the scope each field needs, page sizes and time cursors. For the nightly run, add a sandbox to the developer app with a test TikTok account, sign it in with the three read scopes, and add `SANDBOX_TIKTOK_CLIENT_KEY`, `SANDBOX_TIKTOK_CLIENT_SECRET` and `SANDBOX_TIKTOK_REFRESH_TOKEN` as GitHub Actions secrets.

### TikTok Ads

Reads one advertiser's TikTok campaign report by day through TikTok's API for Business (Marketing API v1.3). Read-only two ways over: the token comes from a developer app made with read scopes only (Ad Account Information and Reporting), and the client's only request is a GET of the report for the advertiser in the settings, with parameters built from one fixed report.

| Setting | What it is |
| --- | --- |
| `TIKTOK_ADS_ACCESS_TOKEN` | A long-lived advertiser token from an app with read scopes only |
| `TIKTOK_ADS_ADVERTISER_ID` | The advertiser's numeric ID |
| `TIKTOK_ADS_ENVIRONMENT` | `production` (the default) or `sandbox` |

**What it reads.** One `BASIC` report at campaign level (`AUCTION_CAMPAIGN`), a 30-day window at a time, by day, 1,000 rows a page: for each campaign, its name and objective, and the spend, impressions, reach, clicks, purchases (`complete_payment`) and purchase value (`total_complete_payment_rate`). The historical import reads two years up to today. Each incremental sync reads again from 28 days before the last day the previous pass read, TikTok's longest attribution window.

**Privacy.** Reports are totals by campaign and day, so nothing names a person. Campaign names are cut short, and one holding an @ is dropped.

**Rate limits and errors.** TikTok answers most errors with HTTP 200 and a code. Rate limits (40016, 40100, 40133, or HTTP 429) and passing faults on TikTok's side (50000, 51001, 51002, 51004, 51041, 51043, 60001, or HTTP 5xx) are retried three times, doubling from a second, before the error goes to the sync runner, which resumes from its checkpoint next time. Codes 40001, 40102, 40104 and 40105 mean the token lacks a scope, expired or was revoked: authorize the app again. TikTok's own message is never shown, only its code.

**Writes.** Pausing and resuming a campaign are declared, so they can be gated and audited, and both are turned off. Each needs a named person's approval and is capped at five a day. Turning them on would also need an app with the Ads Management scope, which isn't requested.

**Events.** `ads.campaign_reported`, the same event Google Ads and Meta Ads give, one per campaign and day, with money in cents of the advertiser's currency. Each is keyed by its day, its campaign and a digest of its numbers, so a revised row is stored as a new version and an unchanged one is a duplicate. A row without a campaign ID or a day that reads is dead-lettered.

**Testing.** The tests run against a mock built from TikTok's docs (`packages/testkit/src/mocks/tiktok_ads.ts`), which checks the token, the advertiser, campaign level by day, the metrics, the 30-day range and paging. For the nightly run, make a sandbox advertiser in the TikTok for Business Developers portal and add `SANDBOX_TIKTOK_ADS_ACCESS_TOKEN` and `SANDBOX_TIKTOK_ADS_ADVERTISER_ID` as GitHub Actions secrets.

### Trello

Reads Trello's REST API (`https://api.trello.com/1`) with a Power-Up's API key and a member's token: the token's own permissions, the boards the member can see (closed ones too), and each board's lists, custom fields, cards and card actions.

| Setting | What it is |
| --- | --- |
| `TRELLO_API_KEY` | The API key of a Power-Up made for KaratOS in the client's workspace |
| `TRELLO_TOKEN` | A token authorized with `scope=read` only, by a member who sees only the boards to sync |

**Read-only.** Before every sync the connector asks Trello what the token may do (`GET /tokens/{token}?fields=permissions`) and stops if any permission can write, saying to authorize a new read-only token and revoke the old one. The client sends only six GETs: that one, `/members/me/boards`, and a board's `/lists`, `/customFields`, `/cards` and `/actions`, with parameters it builds itself. The key and token go in the `Authorization` header, not the URL, and every board, card and action id is checked before it goes into a request. Creating and moving a card are declared behind the write gate, and the test shows each one is stopped.

**What it reads.** Every request names its fields, and none of them is a card's name or description. Trello can't list cards by when they changed, so each pass reads every card on each board, 1,000 a page, paging back by the oldest card's id, and keeps those active since the pass's start; a card read again unchanged is a duplicate. Then it reads the board's card actions since that time, 1,000 a page, newest first: cards created, copied or moved onto the board, moved between lists, deleted, and commented on. The first import starts five years back. Each later sync starts where the last pass began, less five minutes. Each batch's checkpoint records the board and the page it got to, so a resumed sync carries on. A board deleted, or that the member lost access to, part way through a pass is skipped. A 429 waits for Trello's next 10-second window, three times, then is left to `runSync`, which retries from the checkpoint. A 401 stops the sync saying the key and token were turned down.

**Events.** The same vendor-neutral work-tracking events monday.com and Asana send, plus card moves.

| Event | From | Key |
| --- | --- | --- |
| `work.board_updated` | A board: its name, whether it's closed, when it was made, its workspace, its lists as groups (name, position, archived) and its custom fields as columns | board and last activity |
| `work.item_updated` | A card: its board and list, whether it's archived, whether its due date is marked done, when it was made and last active, start and due times, members as `trello:member:<id>`, label names, checklist items and how many are checked, how many comments, and its custom field values | card and last activity |
| `work.item_moved` | A card added to a list (created, copied or moved onto the board) or moved between lists: from and to which list, when, and by whom | action |
| `work.item_deleted` | A card deleted | action |
| `work.comment_updated` | A comment on a card: who wrote it and when | action |

Custom fields are kept only for types that hold no free text: number, date, checkbox and dropdown (its option label). Text fields are dropped. An action's data also carries the comment's text and the card's and list's names; only their ids are read. A card whose last activity doesn't read is dead-lettered.

**Webhooks.** None yet. The scheduled sync polls.

**Testing.** The tests run against a mock built from Trello's API reference (`packages/testkit/src/mocks/trello.ts`). Like Trello, it returns only the fields asked for, except an action's data, which it returns whole, so the tests show card names, descriptions and comment text never reach a stored event. It answers 401 for the wrong key or token, reports a write token's permissions, filters closed cards, pages cards and actions with `before`, and can answer 429. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, make a free Trello workspace for testing only with a board or two of synthetic cards, a Power-Up for its API key, and a read-only token for a member who belongs only to it, and add them as the `SANDBOX_TRELLO_API_KEY` and `SANDBOX_TRELLO_TOKEN` GitHub Actions secrets.

### Trustpilot

Reads the store's Trustpilot page: every service review and the trust score, so marketing sees the store's reputation next to its sales, and every bad review gets an owner. Reviews arrive as the same `review.updated` events the Yext, Birdeye, Yotpo and Judge.me connectors give.

| Setting | What it is |
| --- | --- |
| `TRUSTPILOT_API_KEY` | The API key of a Trustpilot application, never its secret |
| `TRUSTPILOT_BUSINESS_UNIT_ID` | The store's business unit id |

**Read-only by design.** Trustpilot has no read-only scope: an application's key and secret make a business user token that can reply to reviews and send invitations. So KaratOS asks for the key alone. The key reaches only Trustpilot's public endpoints, which show what anyone can see on the store's Trustpilot page, and the client sends only two GETs to `https://api.trustpilot.com/v1`, with the key in the `apikey` header: the business unit, and its reviews, with parameters it builds itself from checked values. Replying to a review and sending an invitation are declared behind the write gate, needing approval, turned off, and the client has no request to send them.

**What it reads.** Trustpilot lists a store's reviews newest first, 100 a page by number, with no filter by date. So each pass reads from the newest and stops at the first page that reaches back past its start. The first import reads five years. Each later sync reads the reviews posted in the last 30 days again, so a reply or an edit in that time is a new event and the rest are duplicates. Each pass reads the trust score with its first page. Each page is one batch, and the checkpoint keeps the pass's start and the next page, so a resumed pass goes on from that page.

**Events.**
- `review.updated` for each review: the rating, a title and excerpt with email addresses and phone numbers masked, the language, whether Trustpilot verified it and whether it counts toward the trust score, likes, whether and when the store replied, and when the customer had the experience, posted it and edited it. A review of two stars or fewer is marked for follow-up, and one without a reply is marked as waiting on one.
- `review.score_updated` for the trust score: the score and stars, the number of reviews, how many count toward the score, and how many there are at each rating. A score that hasn't moved is a duplicate.

Each event is keyed by a digest of what was kept. A review without an id, a rating from 1 to 5 or a time, or a business unit without a trust score or a review count, is dead-lettered.

**Privacy.** Only public reviews are read, never the customer emails and order ids private endpoints carry. Reviewers' display names and locations and the store's reply text are never read into an event; a reviewer is Trustpilot's consumer id.

**Not read.** Product reviews and invitations: their lists need a business user's token, which could also write.

**Rate limits.** Trustpilot asks callers to stay under 833 calls in 5 minutes and 10,000 an hour. The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 500, 502, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 or 403 says the key is wrong or the store lost the API module; a 404 says the business unit id is wrong.

**Testing.** API access needs Trustpilot's API module. The tests run against a mock built from Trustpilot's developer docs (`packages/testkit/src/mocks/trustpilot.ts`). It checks the `apikey` header, the business unit, the parameters the review list takes, the order and the page size. It lists what the first client's key must confirm: that `perPage` goes to 100, that an edit leaves `createdAt` alone, and the key's shape.

### Twilio

The store's text messages, WhatsApp messages and calls through Twilio, read from the account's message and call logs: who the store talked to (as a keyed reference), when, which way, on which line and how each one ended. Message bodies are never kept.

| Setting | What it is |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | The account, `AC…` |
| `TWILIO_API_KEY_SID` | A restricted API key, `SK…`, with only the Messaging messages and Voice calls read permissions |
| `TWILIO_API_KEY_SECRET` | The restricted key's secret |
| `TWILIO_CONTACT_KEY` | The instance's key for contact references. Generated by `npm run secrets:setup` and never rotated |

**Access.** The client signs in with the API key and sends only GET requests with no body, to the account's `Messages.json` and `Calls.json` lists and the next-page links Twilio gives for them. A next-page link that points anywhere else (another host, another account, another list) stops the sync. An account SID given as the key SID is turned down: that pairing means the account's Auth Token, which can send messages, buy numbers and change anything on the account.

**What it reads.** Each sync reads messages, then calls, newest first from a start day, up to 1,000 per page, and checkpoints after every page, so a crash resumes on the page it stopped at. The historical import starts five years back (Twilio keeps what its retention allows). Each later sync starts two days before the newest record the previous one saw, so a delivery receipt or a call that ended late is picked up. Records it reads again come back as duplicates.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `communication.message_logged` | Each message: channel (`sms`, `mms`, `whatsapp` or `other`), direction, Twilio's own direction, status, segments, media count, error code, cost and send time | message and status, so a message that goes from sent to delivered is two events and a replay is none |
| `communication.call_logged` | Each call: direction, status, duration, cost, start and end. An inbound call that was busy, not answered or hung up while ringing is `missed` | call and status |

Costs are kept as positive whole micro-units of the account's currency (`-0.00790` is 7,900), without floating point.

**Privacy.** The customer's number (the sender of an inbound record, the recipient of an outbound one) becomes a contact reference, an HMAC-SHA256 under `TWILIO_CONTACT_KEY`, matched on its digits so `whatsapp:+1…` and `+1 (…)` line up. The store's own line is kept as its last four digits. Bodies, media links and Twilio's error messages (which can quote the body) are never put into an event.

**What the brain does with it.** Clienteling flags callers who rang in the last seven days without getting through, until someone calls or texts them back or they get through on a later call.

**No webhooks.** Twilio sends a number's texts and calls to the one URL set on the number, and that URL decides how the line answers. Pointing it at KaratOS would change how the store's phone works, and checking Twilio's signature needs the account's Auth Token, so the scheduled sync reads the logs instead.

**Writes.** Sending a text and placing a call are declared, and the write-gate test shows both are turned down. The restricted key has no permission to do either.

**Testing.** The tests use a stand-in for Twilio's list endpoints shaped from its API reference, with fictional 555-01xx numbers. For the nightly sandbox run, create a restricted key with the two read permissions on a Twilio trial account and add `SANDBOX_TWILIO_ACCOUNT_SID`, `SANDBOX_TWILIO_API_KEY_SID` and `SANDBOX_TWILIO_API_KEY_SECRET` as GitHub Actions secrets.

### UPS tracking

Follows the UPS packages on the business's list, such as repairs going out to a setter, memo goods and customer orders, through UPS's free Tracking API. It shows where each is, flags a delivery exception as soon as UPS records one, and says which parcels needed a signature or went UPS Premier.

| Setting | What it is |
| --- | --- |
| `UPS_CLIENT_ID` | The Client ID of a UPS developer app with only the Tracking product added |
| `UPS_CLIENT_SECRET` | That app's Client Secret |
| `UPS_TRACKING_NUMBERS_FILE` | A text or CSV file of tracking numbers, one or more a line, split by spaces, commas or semicolons. Lines starting with `#` are skipped, and anything that isn't 7 to 34 letters and digits is left out |
| `UPS_ENVIRONMENT` | Optional. `production` (the default) or `test`, UPS's Customer Integration Environment |
| `UPS_MAX_TRACKING_PER_SYNC` | Optional. The most numbers one sync reads, 500 when unset |

**What it reads.** UPS keeps no feed of changes, so each sync reads every number on the list that isn't delivered or returned yet, oldest first, 25 to a checkpoint. A delivered or returned package is never read again, and a number that never reaches either is dropped 120 days after it was first read. A number taken off the list is forgotten. The historical import and the incremental sync do the same; a status that hasn't changed comes back as a duplicate.

The client signs in with the client id and secret (OAuth client credentials) and keeps the token until five minutes before it runs out. It calls `GET /api/track/v1/details/{number}` only, with a fresh `transId` each time, and asks for no signature image, proof of delivery or milestones. A 401 signs in again once; a 429 or 503 waits as Retry-After says, up to a minute, three times. A number UPS doesn't know (404, or a 200 with only a warning) is skipped and read again next sync.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `shipment.tracked` | One package's tracking: status (`label_created`, `picked_up`, `in_transit`, `out_for_delivery`, `delivered`, `exception`, `returned` or `unknown`), UPS's status code and text, latest scan time, scheduled or rescheduled delivery day, delivered day, service, whether a signature was asked for, UPS Premier level, and the destination's state and country | tracking number and a hash of what was kept, so a new scan is a new event and the same status read again is a duplicate |

A package's time is its latest scan, or when it was read when UPS has no scan yet. Names, street addresses, postal codes, who signed, signatures, photos, proof of delivery and payment details are never kept, even when UPS sends them. No department reasons over these events yet.

**Writes.** None. KaratOS never creates labels, pickups or returns.

**Testing.** The tests run against a mock built from the OpenAPI files UPS publishes (`packages/testkit/src/mocks/ups.ts`), with synthetic packages. UPS's status type letters aren't listed in those files, so the mock's assumptions name them for the first live run to check. The nightly sandbox run signs in at UPS's test environment and reads two of UPS's test tracking numbers once `SANDBOX_UPS_CLIENT_ID` and `SANDBOX_UPS_CLIENT_SECRET` are set.

### Verkada store traffic

Reads how many people came into the store and went out, hour by hour, from each Verkada camera's counting line, so the owner sees footfall against sales.

| Setting | What it is |
| --- | --- |
| `VERKADA_API_KEY` | A read-only API key from the organization's admin |
| `VERKADA_REGION` | `us` (the default) or `eu`, where the organization's data lives |

**Read-only by design.** Verkada API keys are made read-only or read/write, and their permissions can't change later, so the setup asks the admin for a read-only key. The connector trades it for a token that lasts 30 minutes (`POST /token` with the key in `x-api-key`), sends the token in `x-verkada-auth`, and sends only two GETs: the cameras with Occupancy Trends turned on and their counting lines, and the hourly counts across a line. It declares no writes.

**What it reads.** Verkada answers one camera's line at a time, over a time range, by hour. A pass lists the cameras and their lines, then reads each line a week at a time up to the last whole hour. The first import reads two years back. Each later sync reads from two hours before where the last one ended, since Verkada can still be counting the last hours; the first later sync reads the last day. An hour read again unchanged is a duplicate, and a recount is a new event. Each week of a line is one batch, and the checkpoint keeps the pass's range, its lines and where it is, so a resumed sync goes on from there.

**Events.** `store.traffic_counted` for each hour across each counting line: the camera and line, the camera's name and site, the hour's start and end, and how many people came in and went out. It is dated at the end of its hour. An hour that doesn't read, or an answer for another camera, is dead-lettered.

**Privacy.** Counts only: the site's street address, the organization's name and any video or thumbnail are never read into an event.

**Rate limits.** Verkada allows 300 calls a minute for an organization, enforced 25 to each five seconds, so the client spaces calls a quarter second apart. It waits 5, 10 and 20 seconds on a 429, 500, 502, 503 or 504 before the error goes to the sync runner, which resumes from its checkpoint next time. The token is kept until five minutes before it lapses and fetched again once if a call is turned down. A 401 on the token says the key is wrong, expired or in the other region; a 403 says the key can't see the cameras.

**Testing.** Occupancy Trends needs Verkada cameras with the feature on. The tests run against a mock built from Verkada's API docs (`packages/testkit/src/mocks/verkada.ts`). It checks the token, the parameters, the camera and line, and the range. It lists what the first client's organization must confirm: the key the cameras come under, the shape of each hour's entry, that a week at a time is one answer, how lines are picked, and the key's shape.

### TheWatchSearch (by TheWatchCloud)

TheWatchSearch gathers offers from hundreds of dealer WhatsApp groups into one searchable feed, but publishes no API or export. The store is usually already in many of the same groups, and WhatsApp lets any member export a group's chat as a text file, so this connector reads those exports from a folder and keeps the offers in them. A partner feed from TheWatchCloud is the later route, tracked in the private runbook; no vendor is contacted for this one.

| Setting | What it is |
| --- | --- |
| `WATCHSEARCH_IMPORT_DIR` | The folder of chat exports, outside any git repo: one `.txt` file per group, named after the group |
| `WATCHSEARCH_DEALER_KEY` | The instance's key for dealer references. Generated by `npm run secrets:setup` and never rotated |
| `WATCHSEARCH_DATE_ORDER` | Optional. `auto` (the default), `dmy` or `mdy` |
| `WATCHSEARCH_UTC_OFFSET` | Optional. The exporting phone's offset from UTC, such as `-05:00`. Times are read as UTC without it |
| `WATCHSEARCH_CURRENCY` | Optional. The currency a bare price like `14.5k` is in. Without it, those prices are left out |

**Exports.** In WhatsApp, open the group and choose Export chat > Without media. Android saves `WhatsApp Chat with <group>.txt`, which is read as is. An iPhone saves a zip holding `_chat.txt`: unzip it and rename the file after the group, since a file named only `_chat` names no group and stops the sync with that advice. Only `.txt` files are read, in name order. Both phones' line styles are read (`[22/10/2026, 14:03:21] Dealer: ...` and `22/10/2026, 14:03 - Dealer: ...`), with 12 or 24 hour times and two or four digit years. The date order is worked out from each file: a day over 12 settles it. A file whose dates could be read either way, or that contradicts `WATCHSEARCH_DATE_ORDER`, stops the sync and names the file. A line without a timestamp continues the message above it. System lines, media placeholders and deleted messages are skipped.

**Offers.** Each line of a message is an offer when it names a brand and a reference and either says which way it goes (WTS, selling, available; WTB, LF, looking for, wanted) on the line or at the top of the message, or carries a price, which only a seller writes. From it the connector keeps:

- the brand, from names and the trade's shorthand (AP, PP, VC, RM, JLC, FPJ and others, which count only in capitals)
- the reference, in each house's style: `126610LN`, `15202ST.OO.1240ST.01`, `5711/1A-010`, `310.30.42.50.01.001`, `WSSA0018`, `RM011`. Sizes like `41mm` and phone numbers are never read as one
- the asking price and its currency, from `$14,500`, `€6.200`, `CHF 12'400`, `38.5k USD`, `HKD 1.05m` and the like, without floating point. A price is kept only when its currency is known
- the year on the card (`2023`, `03/2023`), the condition (new or pre-owned) and the set (full set, watch only, box only, papers only)

Everything else in a message, chatter included, is dropped.

**Events.** Each offer is a `watch_market.offer_seen` event for the buying department, keyed by the group, the message's time, the dealer, the line and the reference. A later export of the same group re-reads the file, and the offers already stored come back as duplicates. Offers older than a year are skipped. Every event carries `sourceRow` (`Rolex Dealers HK.txt:12`) to find the line.

**Privacy.** Dealers are kept as keyed references (HMAC-SHA256 with `WATCHSEARCH_DEALER_KEY`): a number matches however it is written, and a name matches without regard to case or spacing, but neither is stored. The group is kept by the name the store gave its export. The messages' own words, and any names, numbers or clients mentioned in them, never leave the export.

**What the brain does with it.** When three or more dealers have asked for the same reference in the last 14 days, buying recommends offering one to them, with the lowest price other dealers in the groups are asking.

**Testing.** The tests use synthetic exports in both phones' styles, with fictional dealers and 555 numbers. They cover the date and price readers, every runSync scenario, re-exports, the history cutoff and a real folder.

### Whatnot

Reads one Whatnot seller's account through the Whatnot Seller API, REST v2, at `https://api.whatnot.com/seller-api/rest/v2` ([introduction](https://developers.whatnot.com/getting-started/introduction)): its orders from live shows and the marketplace, with their line items, and its products with each variant's price and available stock. They arrive as the same events the Etsy and eBay connectors give, so a Whatnot sale reads like any other, with `channel: "event"` for a sale in a live show.

| Setting | What it is |
| --- | --- |
| `WHATNOT_ACCESS_TOKEN` | A seller API token: a personal access token (`wn_pat_tk_...`) the account owner creates, or an OAuth app token (`wn_access_tk_...`) |

**Sign-in.** Requests carry `Authorization: Bearer <token>` and a User-Agent naming KaratOS ([authentication](https://developers.whatnot.com/getting-started/authentication)). Only the account owner can create tokens, on the Personal access tokens tab of Whatnot's developer dashboard. Create the token with exactly two permissions, `read:orders` and `read:inventory`, and nothing else: no write permission, and not `read:customers`, since no buyer details are kept. Whatnot shows the token once; it can expire after 7, 30, 60 or 90 days, on a custom date, or never. The token is checked before anything is sent: it must start `wn_pat_tk_` or `wn_access_tk_`. A 401 or 403 stops the sync with a message saying the token must be a Whatnot seller API token with `read:orders` and `read:inventory`, and Whatnot's problem type, such as `missing-scope`, when it gives one. The client sends GET requests to the four lists below and has no way to send anything else.

**What it reads.** `GET /orders`, then `GET /orders/{order_id}/items` for each order, then `GET /products`, then `GET /products/{product_id}/variants` for each product, 50 a page, following `next_cursor` ([orders](https://developers.whatnot.com/api-reference/tag/orders), [products](https://developers.whatnot.com/api-reference/tag/products)). Whatnot's lists take only `limit`, `cursor` and `reverse`: there is no created-since or updated-since filter. So the historical import reads every order oldest first, then every product oldest first, and stops for good. Each later sync reads orders newest first and stops after a page where every order was created more than 60 days ago, then reads every product again (sellers list few). What didn't change comes back as duplicates. A change to an order older than 60 days isn't seen until the next historical import. Each page is a batch, and the checkpoint keeps Whatnot's cursor, so a sync that stops resumes at the same page. Whatnot allows 10 requests a second per seller and app ([rate limits](https://developers.whatnot.com/getting-started/rate-limits)); a 429 (or a 500, 502, 503 or 504) is retried three times, honoring `Retry-After` up to a minute or else waiting 1, 2 and 4 seconds, before the sync stops and resumes from its checkpoint. Errors are read as problem details ([errors](https://developers.whatnot.com/errors)).

**Events.**

- `order.updated` for each version of an order: its status (pending, pending fulfillment, completed, cancelled or failed), whether it's paid, completed or cancelled, the format (auction, buy it now, giveaway), the show it sold in, the subtotal, shipping, tax, seller discount and total in whole cents, the currency and its line count, with `marketplace: "whatnot"`. It is keyed by the order's id, status and last update.
- `sale.completed` once an order is ready to fulfill, completed or cancelled and its lines all read, keyed by order so a later change never counts it twice: each line's SKU (or `whatnot-variant-<id>` when the seller set none), quantity and unit price. Whatnot doesn't say how the buyer paid, so the payment is `other`. A giveaway with nothing paid is no sale.
- `sale.returned` once an order is cancelled, keyed by order, with each line refunded in full. A cancelled order gives both the sale and the return, so it nets to zero whether or not the sale was seen before it was cancelled. Whatnot's REST API has no refunds, so a partial refund isn't seen.
- `product.updated` for each product, with its variants' SKUs, prices and available quantities, keyed by a digest of what is kept. Whatnot's products have no status, so each is `ACTIVE`.
- `inventory.counted` for each variant's available quantity at Whatnot's default location, keyed by the variant, the quantity and the product's last update.

No buyer id, username or display name is kept, nor item or product descriptions, media, or dashboard links. An order, line, product or count that doesn't read is dead-lettered with what was wrong, never guessed.

**Writes.** Cancelling an order is declared behind the write gate, needing approval each time and at most five a day, and turned down while writes are off. The token has no write scope and the client has no way to send it.

**Testing.** Whatnot's REST API has no sandbox. The mock (`packages/testkit/src/mocks/whatnot.ts`) is built from Whatnot's API reference, and its assumptions list what the first live run on a seller's account must confirm, among them the key orders and products are sorted by and that the product lists need `read:inventory`.

### Wix

Reads one Wix site through the Wix REST APIs (`https://www.wixapis.com`), signed in as a self-managed Wix app installed on the site. Many Wix reads are POST requests (`.../query`, `.../search`), so the method says nothing about whether a request changes data. Read-only is enforced in the client instead: it sends only eight exact method and path pairs, each with its own body keys, and anything else is stopped before a request is made:

| Request | What for |
| --- | --- |
| `GET /apps/v1/instance` | The permissions the site owner granted the app (checked before the first read) |
| `GET /stores/v3/provision/version` | Which Wix Stores catalog the site runs |
| `POST /stores/v3/products/query` | Catalog V3 products |
| `POST /stores/v3/products/query-variants` | Their variants, SKUs and prices |
| `POST /stores/v3/inventory-items/query` | Catalog V3 stock, per variant and location |
| `POST /stores/v1/products/query` | Catalog V1 products, with their variants and stock |
| `POST /ecom/v1/orders/search` | eCommerce orders |
| `POST /contacts/v5/contacts/query` | Contacts |

The token comes from `POST /oauth2/token`. The writes it may do later (update inventory, update products) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `WIX_APP_ID`, `WIX_APP_SECRET` | The app's ID and secret key, from Develop > OAuth in the app's dashboard |
| `WIX_INSTANCE_ID` | The app's instance ID on the client's site, one per site |
| `CUSTOMER_REF_KEY` | Keys the customer references (below). Generated by `npm run secrets:setup`; never rotated |
| `WIX_WEBHOOK_PUBLIC_KEY` | Optional. The app's public key (PEM), for when webhooks are turned on |

**Why an app, not an API key.** Wix API keys get their permissions when they are made, and Wix documents no way to read them back, so a key with Manage permissions couldn't be caught. API keys also get no webhooks. An app's granted permissions can be read (Get App Instance lists them), and only apps receive webhooks. So the connector uses an app with the OAuth client credentials grant: app ID, app secret and the site's instance ID give an access token that lasts four hours, sent bare in the `Authorization` header (no `Bearer`). It is renewed five minutes early, or once when Wix answers 401.

**The app's permissions.** Before the first read of each run, the connector reads `instance.permissions` and stops if any permission isn't a read: anything naming Manage, Write, Edit, Create, Delete, Update, Modify, Remove, Send, Charge or Refund, anything without Read, and anything it can't parse. The one exception is Manage Your App (`SCOPE.DC.MANAGE-YOUR-APP`). Wix needs it for that very call, and it reaches only the app's own install. If Wix doesn't list the permissions, or answers for a different instance, the connector stops too. The app needs these read permissions:

- Read Orders (`SCOPE.DC-STORES.READ-ORDERS`);
- Read Products and Read Inventory for Catalog V3 (`SCOPE.STORES.PRODUCT_READ`, `SCOPE.STORES.INVENTORY_ITEM_READ`, and `SCOPE.STORES.PRODUCT_READ_ADMIN` to include hidden products);
- Read Catalog Version (`SCOPE.STORES.CATALOG_READ_LIMITED`);
- Read Products for Catalog V1 (`SCOPE.DC-STORES.READ-PRODUCTS`);
- Read Contacts (`SCOPE.DC-CONTACTS.READ-CONTACTS`).

**What it reads.** Wix Stores runs one of two catalogs, which aren't compatible, and a site moves from V1 to V3 once. Each pass first asks which one the site has, then reads, in order:

1. Products: for V3, products and their read-only variants (by product ID); for V1, products with their variants and stock.
2. V3 inventory items.
3. Orders.
4. Contacts.

A site without Wix Stores gives orders and contacts only. The historical import reads the whole catalog, all stock and every contact, and five years of orders by when they last changed. Search Orders leaves out pending and rejected orders unless they are named, so the filter names every status. Each stream is filtered with `updatedDate` `$gte` (V1: `lastUpdated`) and sorted oldest change first. V3, eCommerce and contacts page with Wix's cursor: the first request carries the filter and sort, and later ones carry only the cursor, as Wix documents. The checkpoint keeps the cursor, so a crash resumes at the next page. If Wix no longer takes a saved cursor, the stream starts again from the newest change it had read. V1 pages by offset, so after each page the next request starts at the newest change on it, and only a page of products changed at the same instant is paged by offset. Incremental passes start five minutes before the newest change the last pass saw, per stream; with no checkpoint they look back 48 hours.

**Events.** The same types and shapes as the Shopify, Square, Clover, WooCommerce and BigCommerce connectors:

- Orders give `order.updated` (Shopify's shape), with Wix point of sale orders as `store` and everything else as `online`.
- An order gives `sale.completed` once it is paid, partly refunded or refunded. Wix orders carry no payment method, so the payment is `other`.
- Wix records refunds on the order as each line's running `refundQuantity`, with no dates. Each refunded unit becomes its own `sale.returned`, keyed by order, line and unit, at the line's price after tax. A later refund adds only its new units.
- Products give `product.updated` with each variant's SKU and price; V1 variants also carry their stock.
- `inventory.counted` is sent for each V3 inventory item, or V1 variant, whose quantity Wix tracks. A negative count is dead-lettered.
- Contacts give `customer.profile_updated`, with marketing consent on only when the main email's subscription is `SUBSCRIBED`.

A line without a SKU becomes `wix-variant-<id>`, `wix-product-<id>` or `wix-line-<order>-<line>`. Each event is keyed by record and by when it changed. A sale is keyed by its order alone, and a product by its variants too, so a replay is a duplicate.

**Privacy.** A contact becomes `wix:customer:<hmac>`: an HMAC-SHA256 of the app instance and the contact's ID, keyed with `CUSTOMER_REF_KEY`. Square, Clover, WooCommerce, BigCommerce and custom forms use the same key. One buyer's orders and profile link up, and two sites never share references. The profile's name is a label made from that reference. Nothing else is kept: no names, email addresses, phone numbers, billing, shipping or recipient addresses, buyer notes, custom fields, order activities, extended fields or labels.

**Rate limits.** Wix allows about 200 requests a minute per app instance. On 429 the client waits, with exponential backoff and jitter or `Retry-After` up to a minute, three times. It then hands the error to `runSync`, and the next run resumes from the checkpoint.

**Webhooks.** Wix sends webhooks to apps only. Each delivery's body is a JWT signed RS256 with the app's key pair. `verifyWixWebhook` checks the token against the app's public key (`WIX_WEBHOOK_PUBLIC_KEY`), in this order:

1. its shape and size;
2. that its algorithm is RS256, never `none` or an HMAC, which would let the public key sign;
3. the signature;
4. `exp`, `nbf` and `iat` when present, with a minute of leeway;
5. `iss` when present;
6. that the event is for this site's app instance.

Wix retries a delivery for up to about 47 hours and may send one event more than once. `WixReplayGuard` handles each event ID once within 49 hours. An event older than 48 hours gives no events, since the sync reads it instead. The event keys are the sync's own, so a replay stores nothing twice even after a restart. Order, contact and V3 inventory item events become events. Product events carry no variants (V3) or only the changed fields (V1), and deletions carry only an ID, so they are a prompt to sync. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** Until a Wix dev site is set up, the tests run against a mock built from Wix's docs (`packages/testkit/src/mocks/wix.ts`). The mock:

- checks the app token and each endpoint's permission;
- caps page sizes as documented;
- pages with keyset cursors and answers 400 to a cursor request that carries a filter or sort;
- leaves out pending and rejected orders by default;
- answers V3 endpoints only on a V3 site, and the V1 endpoint only on a V1 site.

Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run:

1. Create a free Wix dev site with Wix Stores and some synthetic products, orders and contacts.
2. Create a self-managed app holding only the read permissions above, and install it on the site.
3. Add `SANDBOX_WIX_APP_ID`, `SANDBOX_WIX_APP_SECRET` and `SANDBOX_WIX_INSTANCE_ID` as GitHub Actions secrets.

**Known gaps.**

- Refund dates and amounts come from the order, not from Wix's order transactions, which aren't read. A refund's time is the order's last change when it was first seen, and a partial refund of a line is split evenly across its units.
- V3 variant prices and V1 product changes reach `product.updated` only when the product's own date moves.

### WooCommerce

Reads a store's WooCommerce REST API v3 (`https://<store>/wp-json/wc/v3/`) with a REST API key, sent only in the Authorization header (HTTP Basic) over https, never in an address. Read-only is enforced in the client: it sends GET requests only, to five read endpoints, each with its own parameters, and anything else is stopped before a request is made: `/products`, `/products/<id>/variations`, `/orders`, `/refunds` and `/customers`. The writes it may do later (update stock, update products) are declared and stay behind the write gate.

| Setting | What it is |
| --- | --- |
| `WOOCOMMERCE_STORE_URL` | The store's home address, `https://` only, e.g. `https://shop.example.com`, or `https://example.com/shop` when WordPress lives in a folder |
| `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET` | A REST API key with **Read** permission (`ck_` and `cs_` followed by 40 hex characters), made under WooCommerce > Settings > Advanced > REST API for an administrator or shop manager |
| `CUSTOMER_REF_KEY` | Keys the customer references (below). Generated by `npm run secrets:setup`; never rotated |
| `WOOCOMMERCE_WEBHOOK_SECRET` | Optional. The secret set on the store's webhooks, for when webhooks are turned on |

**The key's permission.** WooCommerce keys are Read, Write or Read/Write, but the API has no documented way to ask which one a key holds: neither `system_status` nor any other endpoint shows it, and WooCommerce only reveals it by refusing a request the key may not make. Finding out would mean sending a write, so the connector doesn't. The GET allowlist is the guard, and the owner must create a Read key, so the store stays safe even if that ever failed. A Write-only key is caught on the first read, which WooCommerce refuses with "does not have read permissions"; the connector stops and says to create a Read key.

**The store's address.** Each client's store lives at its own address, so the setting is checked before anything is sent: https only (WooCommerce accepts Basic auth only over TLS, and over http the keys would travel in the clear), a public hostname with no user name, password, port, query or fragment, no IP address, no local names such as `localhost` or `.local`, and a path of plain folder names. Before the first request of each run the hostname is resolved and the connector stops if any address is loopback, private, link-local, carrier-grade NAT, reserved or multicast, in IPv4 or IPv6, so the setting can't point it at a private network. Every request goes to that address and redirects are never followed, so the keys never leave the store; a store that redirects (to `www.`, say) needs its final address in the setting. The address is resolved again by the request itself, so a hostname whose DNS changes between the check and the request isn't caught; the instance's own network rules are the backstop.

**What it reads.** In order: products with their variations and stock, orders, refunds and customers. The historical import reads the whole catalog, five years of orders (by when they last changed) and refunds, and every customer. WooCommerce pages by number (`page`, `per_page` up to 100, with the count in `X-WP-TotalPages`, or a full page when a proxy drops that header). Paging by number through a list that changes underneath can skip a record, so orders and products are read oldest change first with `modified_after` and `dates_are_gmt=true`, and after each page the next request starts just before the newest change on it, at page 1 again; only a run of more than a page of records changed in the same second is paged by number. Incremental passes start five minutes before the newest change the last pass saw; with no checkpoint they look back 48 hours. Refunds come from the store-wide refunds list, which filters on the store's local time and documents no GMT option, so refund windows move on local times and reach a day further back. Customers can't be filtered by change: the import reads them all by ID, and an incremental pass reads the newest registrations until it reaches ones it has seen. The checkpoint keeps the stream, the window and the page, so a crash resumes at the next page.

**Events.** The same types and shapes as the connectors already built. Orders give `order.updated` (Shopify's shape), `sale.completed` once paid (completed, or processing or refunded with a paid date), with its payment method (card, cash on delivery as cash, cheque as check, bank transfer as wire, financing, gift card or other) and `point of sale` orders as `store`, and `payment.charge_updated` for the order's payment with what has been refunded (Stripe's shape). Refunds give `payment.refund_updated` and, when they return lines, `sale.returned` against the order. Products give `product.updated` with each variation's SKU, price and stock, and `inventory.counted` for each product or variation whose stock WooCommerce manages; a negative count (backorders) is dead-lettered. Customers give `customer.profile_updated` with marketing consent off, since WooCommerce keeps none. A line without a SKU becomes `woocommerce-variation-<id>` or `woocommerce-product-<id>`. Each event is keyed by record and when it changed (a sale by its order alone, a product by its variations too), so a replay is a duplicate.

**Privacy.** A customer becomes `woocommerce:customer:<hmac>`, an HMAC-SHA256 of the store's hostname and the customer's ID keyed with `CUSTOMER_REF_KEY`, the key custom forms, Square and Clover use for theirs; the profile's name is a label made from that reference, and a guest order has none. No names, email addresses, phone numbers, billing or shipping addresses, customer notes, IP addresses, user agents, transaction IDs, refund reasons, line item notes or meta data are kept.

**Rate limits.** WooCommerce has none of its own, but hosts and firewalls in front of it may answer 429. The client waits with exponential backoff and jitter (1, 2 and 4 seconds, or `Retry-After` up to a minute), then hands the error to `runSync`, and the next run resumes from the checkpoint.

**Webhooks.** `verifyWooCommerceWebhook` checks `X-WC-Webhook-Signature`, the base64 HMAC-SHA256 of the raw body keyed with the webhook's secret, in constant time. WooCommerce decodes HTML entities in the secret before signing, so use one of letters and digits only. WooCommerce signs no timestamp and never retries a delivery, so a captured one stays valid: `WooCommerceReplayGuard` handles each `X-WC-Webhook-Delivery-ID` once within 25 hours, a delivery whose record last changed more than a day ago gives no events (the sync reads it instead), and the event keys, the same ones the sync uses, stop a replay from storing anything twice after a restart. Order, customer and simple product deliveries become events (`handleWebhook({ topic, payload })`); a variable product's delivery lacks its variations and a deletion carries only an ID, so they are a prompt to sync. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** Until a test store is set up, the tests run against a mock built from WooCommerce's docs (`packages/testkit/src/mocks/woocommerce.ts`), which checks Basic auth and the key's permission as WooCommerce does, caps `per_page` at 100, sends the page headers, keeps the documented defaults, filters exclusively, and runs its clock five hours behind GMT so local and GMT times differ. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, set up a WooCommerce test store on a public https address (a staging copy or a free WordPress test site), add some synthetic products, orders, refunds and customers, create a Read key, and add `SANDBOX_WOOCOMMERCE_STORE_URL`, `SANDBOX_WOOCOMMERCE_CONSUMER_KEY` and `SANDBOX_WOOCOMMERCE_CONSUMER_SECRET` as GitHub Actions secrets.

**Known gaps.** A variation's own stock change may not move its product's modified date, so an incremental pass can miss it until the product next changes; sales still reach inventory through orders. The store-wide refunds list needs a recent WooCommerce; an older store answers `rest_no_route` and the connector says to update.

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

### Yext

Reads the store's Yext account through Yext's Management API (v2): its locations and the reviews Yext gathers from Google, Yelp, Facebook and the other publishers it watches. Read-only by request: its only requests are two GETs, the location list and the review list, with parameters it builds and checks itself. Yext API keys carry no scopes the connector could check, so give the app the key belongs to read access to Entities and Reviews and nothing else.

| Setting | What it is |
| --- | --- |
| `YEXT_API_KEY` | An API key of a Yext app the store owns, with read access to Entities and Reviews |
| `YEXT_ACCOUNT_ID` | The account to read; unset reads the key's own account |
| `YEXT_ENVIRONMENT` | `production` (default) or `sandbox` |

**What it reads.** Each pass reads every location, 50 a page, with its name, address, time zone and whether it is closed. Then the reviews Yext last updated in a range of days, 100 a page: the last two years on the first import, and on each sync after, the days since the last pass ended, starting two days early so a review updated late on a day already read is read again.

**Events.** `location.updated` for each location and `review.updated` for each review, with its location, publisher, rating, an excerpt, its status, when it was published and last updated, a link to it, how many comments it has, how many are the store's replies, and whether it is still awaiting one. Each is keyed by a digest of what was kept, so an edited or newly answered review is stored as a new version and an unchanged one is a duplicate.

**Privacy.** A review is written by a customer, so it keeps no author name or email, and its title and excerpt (the first 500 characters) have email addresses and phone numbers masked. Replies are counted, not copied. A link keeps its address without the query string.

**Rate limits.** Yext allows 5,000 Management API requests an hour. The client sends one request at a time and waits out a 429, a 500 or a 504, doubling from a second, three tries, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 means the key is wrong, and a 403 that the app lacks read access.

**Writes.** Replying to a review and changing a location's hours are declared so they can be gated and audited, and are turned off. Each needs a named person's approval, and the client has no request to send either.

**Testing.** The tests run against a mock built from Yext's Management API docs (`packages/testkit/src/mocks/yext.ts`), which checks the API key header, the version date, the account, the app's access, page sizes, update-date ranges and that a page token belongs to its query. For the nightly run, add an app in a Yext sandbox account with read access to Entities and Reviews and add its key as the GitHub Actions secret `SANDBOX_YEXT_API_KEY`.

### Yotpo

Reads a store's Yotpo reviews and, when Loyalty is set up, its members' points and tiers, so staff can thank fans and look after unhappy buyers. Reviews arrive as the same `review.updated` events the Yext and Birdeye connectors give.

| Setting | What it is |
| --- | --- |
| `YOTPO_STORE_ID` | The store ID (app key), from Reviews > Settings > General Settings |
| `YOTPO_API_SECRET` | The store's API secret, from the same page |
| `YOTPO_LOYALTY_GUID` | Optional: the Loyalty program's GUID, from Loyalty > Settings |
| `YOTPO_LOYALTY_API_KEY` | Optional, with the GUID: the Loyalty API key |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** Yotpo gives a store one API secret and one Loyalty API key, and neither can be limited to reading: the secret could moderate and reply to reviews, and the Loyalty key could adjust points. The client is what keeps KaratOS to reading: its only requests are the access token request and two GETs, Retrieve all reviews (`api.yotpo.com/v1/apps/{store}/reviews`) and Fetch recently updated customers (`loyalty.yotpo.com/api/v2/customers/recent`), to Yotpo's fixed addresses, with filters built from checked values. Replying to a review and adjusting points are declared behind the write gate, turned off, and the client has no request to send them.

**What it reads.** Reviews updated since a day (`since_updated_at`), unpublished ones included so a hidden review shows as unpublished, 100 to a page by page number. The first import covers five years. Each later sync reads from two days before the last pass started, since Yotpo's data lags an hour. Then, with Loyalty set up, the members Yotpo updated in the last seven days, 500 to a page by cursor; Loyalty has no older list, so a member's balance arrives the next time it changes. Each page is one batch and one checkpoint.

**Events.** `review.updated` for each review, with its id, whether it is about a product (and the sku) or the store, the rating, title and excerpt with email addresses and phone numbers masked, Yotpo's sentiment score, whether the reviewer was a verified buyer or incentivized (and how), helpful votes, whether it is published or escalated, the reviewer's customer reference, and when it was posted and last changed. `loyalty.customer_updated` for each member, with their points balance, points earned, when points expire, perks redeemed, VIP tier and its dates, total spend in cents and purchases, last purchase and visit, whether they opted in and have a store account, and their customer references. Each is keyed by a digest of what was kept, so an unchanged review or balance is a duplicate. A review without an id, a rating or a time that reads, or a member without an id, is dead-lettered.

**Privacy.** Reviewers' and members' email addresses and phone numbers only make keyed customer references. Names, birthdays, anniversaries, the store platform's customer id and referral links aren't kept.

**Rate limits.** Yotpo allows 5 requests a second per store. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 on reviews drops the token so the next read asks for a new one.

**Testing.** Yotpo has no sandbox, so the tests run against a mock built from Yotpo's docs (`packages/testkit/src/mocks/yotpo.ts`). It checks the store ID, secret, token, Loyalty GUID and key, the filters and paging, and lists what the first client's store must confirm: the order reviews come back in, that a page past the last is empty, and the day `since_updated_at` is read in.

### Zendesk

Reads the store's Zendesk helpdesk: every ticket and every customer who opened one, so clienteling, sales and repairs see what customers asked about and how fast the store answered.

| Setting | What it is |
| --- | --- |
| `ZENDESK_SUBDOMAIN` | The helpdesk's subdomain: `store` for store.zendesk.com |
| `ZENDESK_CLIENT_ID` | The unique identifier of the OAuth client an admin made for KaratOS |
| `ZENDESK_CLIENT_SECRET` | That client's secret |
| `ZENDESK_REFRESH_TOKEN` | The refresh token from an admin authorizing the client for `tickets:read` and `users:read` |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** KaratOS doesn't use a Zendesk API token, which carries its admin's full permissions. An admin authorizes an OAuth client for only `tickets:read` and `users:read`, and every refresh asks for those two scopes again, which can only narrow the token. If the token answer lists a scope that isn't a read scope, the client stops before reading anything. It sends only three requests to the store's own `https://{subdomain}.zendesk.com`: the refresh-token sign-in and the cursor-based ticket and user exports, with parameters it builds itself from checked values and Zendesk's cursor, never from a link in an answer. Adding an internal note and tagging a ticket are declared behind the write gate, each needing approval, turned off, and the client has no request to send them.

**Rotating refresh tokens.** Zendesk's refresh tokens are single-use: each refresh returns a new one and retires the old. The newest is saved, encrypted under a key derived from the client secret, in the instance's database before it is used, as QuickBooks's is; `ZENDESK_REFRESH_TOKEN` is the seed, and replacing it there wins over the stored one. Each refresh asks for a 90-day refresh token, Zendesk's longest, so a sync at least that often keeps the connection alive.

**What it reads.** Zendesk's incremental exports list every record that changed since a time, oldest change first, up to 1,000 a page, and end with a cursor that picks up from there next time. The first import starts the ticket and user exports five years back and reads each to its end, tickets first. Each later sync goes on from the cursors the last one ended with, so it reads only what changed; with no checkpoint it starts two days back. An unchanged record read again is a duplicate. Each page is one batch, and the checkpoint keeps both cursors.

**Events.**
- `communication.ticket_updated` for each ticket, as Gorgias's are: status, type, priority, the channel it came in by, tags (lowercased, up to 20), the requester, submitter and assignee (Zendesk user ids), its organization, group and brand, the satisfaction rating (offered, unoffered, good or bad), whether it is public, and when it was created, is due and last changed.
- `customer.profile_updated` for each end user, never staff: `zendesk_user:{id}` as the customer, the customer references of their email and phone, their organization and tags, and whether they are verified, suspended or deleted. Zendesk doesn't record marketing consent, so none is claimed.

Each event is keyed by a digest of what was kept. A ticket without an id, a creation time or a status, or a user without an id or a creation time, is dead-lettered.

**Privacy.** Subjects, descriptions, comments, names, notes, details and custom fields are never read into an event. Emails and phone numbers become the same customer references custom forms, Klaviyo, Quo and Gorgias make (an HMAC under `CUSTOMER_REF_KEY`), so one person lines up across systems without the address being kept. A ticket's requester and the customer's profile share the Zendesk user id.

**Rate limits.** The ticket export allows 10 requests a minute, and the user export 20. The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. It signs in again once on a 401. A 403 says the token can't read the exports, which need an admin's authorization; a 404 says the subdomain is wrong.

**Testing.** Zendesk trials are vendor accounts. The tests run against a mock built from Zendesk's developer docs (`packages/testkit/src/mocks/zendesk.ts`). It checks the JSON refresh grant, that each refresh retires the last tokens, the bearer token, the parameters each export takes and its order. It lists what the first client's connection must confirm: that a token with `tickets:read` and `users:read` can read the exports, that a narrowed refresh keeps only those scopes, the scope's shape, how a finished export's cursor picks up later changes, the time format and the satisfaction scores.

### Zoom

Reads the store's past Zoom meetings and who joined them, so virtual consultations sit beside the appointments booked in Calendly and the visits in the store. Each meeting arrives as an `appointment.held` event.

| Setting | What it is |
| --- | --- |
| `ZOOM_ACCOUNT_ID` | The Account ID of the store's KaratOS Server-to-Server OAuth app |
| `ZOOM_CLIENT_ID` | That app's Client ID |
| `ZOOM_CLIENT_SECRET` | That app's Client Secret |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** A Zoom admin makes the KaratOS app in the Zoom App Marketplace and gives it only two scopes, `report:read:list_history_meetings:admin` and `report:read:list_meeting_participants:admin` (or the older `report:read:admin`). Every token Zoom issues lists its scopes, and the client checks each one: a token with any scope that isn't a read, or that lists none, is not used, and the sync stops saying which scope to take away. The client's only requests are the token request and two GETs to `api.zoom.us`; it ignores the `api_url` a token answer names. Scheduling a meeting is declared behind the write gate, turned off, and the client has no request to send it.

**What it reads.** Zoom's meeting history (`GET /report/history_meetings`) lists the account's past meetings by the day they started, at most a month at a time, and the participant report (`GET /report/meetings/{uuid}/participants`) lists who joined one. A pass reads the history in 30-day spans, 300 to a page, and each meeting's participants; a meeting Zoom has no report for (a 404) is kept with no guests. The first import covers six months, the longest Zoom keeps reports. Each later sync reads from two days before the last one, since a meeting is listed once it ends and by the account's own time zone. Each history page is one batch. Zoom's page tokens last 15 minutes, so the checkpoint keeps the span rather than the token, and a resumed pass reads its span again; what it already read is a duplicate.

**Events.** `appointment.held` for each meeting, with its UUID and meeting id, start and end, length in minutes, kind (bridal, custom design, repair, appraisal, pickup, consultation or other, read from the topic the same way as Calendly titles), Zoom's participant count and how many guests joined (once each, however often they rejoined), when the first guest joined, a keyed host reference, the guests' customer references, and whether the meeting was recorded, shared a screen or had a meeting summary. Each is keyed by the UUID and a digest of what was kept. A meeting without a UUID or times that read is dead-lettered.

**Privacy.** Guests' email addresses only make the same keyed customer references Calendly, custom forms and Klaviyo make, and the host's becomes a keyed host reference, so neither can be read back. Names, devices, IP addresses and locations aren't kept, and the topic only when it carries no participant's or host's name or address. Recordings, chat, transcripts and summaries are never read.

**Rate limits.** Reports are in Zoom's Heavy rate limit group. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 drops the token so the next read asks for a new one, and a 403 means the plan has no reports (they need Pro or higher).

**Testing.** Reports need a paid Zoom plan, so the tests run against a mock built from Zoom's docs (`packages/testkit/src/mocks/zoom.ts`). It checks the app's credentials, the token and its scopes, the day range, paging and how a UUID with a slash is encoded, and lists what the first client's app must confirm: which day a meeting is listed under, and that a rejoining guest is listed once per join.

<!-- registry:connector-docs:end -->

## Writing back: built, turned off

Every connector starts read-only. A connector may declare the write actions it could perform (`writes` on `Connector`), such as adjusting Shopify stock or creating a QuickBooks invoice, but each one runs through a `WriteGate`:

- The gate refuses any action the instance has not listed in `ENABLED_WRITES`, which is empty by default. Entries are `integration:action`, or `integration:*` for every action of one integration.
- Every attempt is audited, whether it was refused, performed or failed, with who asked for it.
- Connectors request only read scopes from vendors until a client agrees to writes.

So write support can be built and tested now, and switched on per client and per action later.
