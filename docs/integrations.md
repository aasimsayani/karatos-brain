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
| Lightspeed Retail | R | Public API | Unknown | Yes | Planned |
| Square | R | Public API | Free sandbox | Yes | Built (Read scopes only; the connector checks the token's scopes and stops on any other, so a full-access personal token won't do. Sales, refunds, items and stock use the same events as Shopify and the POS exports) |
| Clover | R | Public API | Free sandbox | Yes | Built (Connector in @karatos/connectors: orders, payments, refunds, items, stock and customers, read-only. Clover can't report an app's permissions, so the connector sends only its listed GET requests) |
| Valigara | R, W, M | Unknown | Unknown | No | Planned |
| WooCommerce | R | Public API | Free sandbox | Yes | Built (A REST API key with Read permission over https; the connector sends only GET requests to five read endpoints. Sales, refunds, products and stock use the same events as Shopify, Square and Clover) |
| BigCommerce | R, W | Public API | Free sandbox | Yes | Built (A store-level API account with read-only scopes. BigCommerce can't report a token's scopes, so the connector sends only GET requests to its listed paths. Sales, refunds, products and stock use the same events as Shopify, Square and Clover) |
| Wix | R | Public API | Free sandbox | Yes | Built (A self-managed Wix app holding read permissions only; the connector checks the permissions the site granted and stops on any Manage permission, and sends only eight listed read requests. Webhooks need the app (an API key gets none). Sales, products and stock use the same events as Shopify, Square and Clover) |
| Punchmark | R | Partner | Partner | No | Planned |
| Etsy | R, M | Public API | Unknown | No | Planned |
| eBay | R, W | Public API | Free sandbox | Yes | Planned (Estate and pre-owned pieces) |
| Amazon (Selling Partner API) | R, W, M | Public API | Free sandbox | Yes | Planned (Amazon orders, listings, stock, fees and settlements; notifications arrive through Amazon's queues) |
| TikTok Shop | R | Partner | Unknown | Yes | Planned (Orders, products and returns from TikTok's in-app shop, through an app registered in TikTok Shop Partner Center) |
| Faire | W, M | Public API | Unknown | No | Planned (Wholesale orders from independent boutiques through the Faire marketplace) |
| NuORDER | W, M | Public API | Unknown | No | Planned (B2B wholesale orders, line sheets and buyers, with API keys a brand approves in NuORDER Admin) |
| JOOR | W, M | Partner | Partner | No | Planned (B2B wholesale orders and buyers; JOOR's integrations team issues API tokens) |
| Squarespace Commerce | R | Public API | Paid account | Yes | Planned (Orders, products, stock, customers and transactions from a Squarespace store) |
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
| Whatnot Seller API | R, W | Partner | Free sandbox | Yes | Planned (Live-shopping products, listings, orders and sale webhooks. Seller API by approval; partner only. Exhibited at JIS Fall 2026) |
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
| GIA Report Results | R, W, M | Public API | Free sandbox | No | Built (Looks up each certificate number on the business's list once, then follows GIA's free changed-reports feed. GIA's free plan includes a sandbox key; lookups of reports the business didn't submit cost per lookup. The docs watch follows the API changelog, and the nightly sandbox run catches API changes) |
| IGI report verification | R, W | Unknown | Unknown | No | Planned (Web lookup only; no API found) |
| GemGuide Appraisal Software | R | Unknown | Unknown | No | Planned |
| HRD Antwerp report check | R, W | Unknown | Unknown | No | Planned (Web lookup through MyHRD only; no API found) |
| GCAL report verification | R, W | Unknown | Unknown | No | Planned (Web lookup through GCAL by Sarine only; no API found) |
| Supplier invoices and memos | R, W, M | File export | Sample files | No | Planned (Invoice and memo PDFs or CSVs from any supplier, read for memo terms and Kimberley Process and System of Warranties statements) |
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
| nFusion Solutions metals feed | R, W, M | Public API | Paid account | No | Planned |
| Metals-API | R, W, M | Public API | Free sandbox | No | Built (Spot prices for gold, silver, platinum and palladium in dollars per troy ounce. No public API changelog; the nightly sandbox run catches API changes) |
| Tenoris | R, W, M | Partner | Partner | No | Planned (Category and price-point sales benchmarks from independent jewelers. Partner only. Found in jewelry industry sources) |
| Edge Retail Academy and Edge Pulse | R | Partner | Partner | No | Planned (Peer KPI benchmarks, inventory aging, turn and open-to-buy guidance. Partner only. Exhibited at Centurion) |
| TheWatchSearch (by TheWatchCloud) | R, W | File export | Sample files | No | Built (Reads the WhatsApp group chat exports the store already has, since TheWatchSearch publishes no API or export. A partner feed from TheWatchCloud comes later) |
| Search The Watch Market Business API | R, W | Public API | Paid account | No | Planned (Prices, 13-week price history, days to sell and recent listings by reference. Public API on a paid plan. Found in luxury watch trade research) |
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
| Birdeye | R | Public API | Unknown | No | Planned |
| Klaviyo | R | Public API | Free sandbox | Yes | Built (Read-only by allowlist: Klaviyo can't be asked which scopes a private key holds, so the connector sends only listed reads and the two read-only report queries. Webhooks need Advanced KDP or a Klaviyo app) |
| Attentive | R | Public API | Unknown | Yes | Planned |
| Twilio | R, W | Public API | Free sandbox | No | Built (Text message and call logs through a restricted API key with read permissions only. Message bodies are never kept, and no webhooks, since pointing a number's webhook at KaratOS would change how the store's line answers) |
| Calendly | R | Public API | Free sandbox | Yes | Planned (Appointments for consultations, bridal and repair drop-off) |
| Acuity Scheduling | R | Public API | Paid account | Yes | Planned |
| Mailchimp | R | Public API | Free sandbox | Yes | Planned |
| Google Analytics 4 | R, W | Public API | Free sandbox | No | Planned |
| Google Ads | R | Public API | Free sandbox | No | Planned (Test accounts for development; production needs an approved developer token) |
| Meta Ads | R | Public API | Free sandbox | No | Planned |
| Google Business Profile | R | Partner | Partner | No | Planned (Reviews and local listings; Google approves API access on request) |
| Microsoft 365 Outlook mail and calendar | R, W, M | Public API | Paid account | Yes | Planned (Customer and vendor email and appointments for stores on Microsoft 365, read-only. Microsoft's free developer tenant now goes only to Visual Studio subscribers) |
| Any other mailbox (IMAP) | R, W, M | Public API | Sample files | No | Planned (Read-only mail from any provider that offers IMAP, for stores not on Google or Microsoft) |
| Microsoft Teams | R, W, M | Public API | Paid account | Yes | Planned (Channel messages where staff hand off repairs, custom orders and sales, like Slack. Microsoft Graph has one changelog, watched through the Outlook entry) |
| RingCentral | R, W, M | Public API | Paid account | Yes | Planned (Business phone call logs, texts and voicemail. RingCentral replaced its free developer account with a low-cost package) |
| Quo (formerly OpenPhone) | R | Public API | Unknown | Yes | Planned (Small-business calls and texts, with call recordings and transcripts) |
| Zoom | R, W, M | Public API | Unknown | Yes | Planned (Virtual consultations: who met, when and for how long, and whether it was recorded) |
| Gorgias | R | Public API | Paid account | Yes | Planned (E-commerce helpdesk tickets from email, chat and social, common with Shopify jewelry brands) |
| Zendesk | R, W, M | Public API | Paid account | Yes | Planned (Helpdesk tickets and customer conversations. Zendesk offers a 14-day trial, and sponsored test accounts only to Marketplace partners) |
| Apple Messages for Business | R | Partner | Partner | No | Planned (iMessage conversations with customers, reached through a messaging service provider Apple has approved) |
| Postscript | R | Partner | Partner | Yes | Planned (Shopify SMS marketing. Custom API access is limited to enterprise plans and integration partners) |
| Yotpo reviews and loyalty | R | Public API | Unknown | Yes | Planned (Product reviews, questions, photos and loyalty points) |
| Judge.me | R | Public API | Unknown | Yes | Planned (Shopify product reviews and ratings) |
| Smile.io | R | Public API | Paid account | No | Planned (Loyalty points, VIP tiers and referrals. The API needs the Plus or Enterprise plan) |
| Trustpilot | R, W | Public API | Paid account | No | Planned (Company reviews and trust score. The API needs Trustpilot's API module add-on) |
| Pinterest | R, M | Public API | Free sandbox | No | Planned (Organic pins, boards and pin analytics, where bridal shoppers save ideas) |
| TikTok | R | Public API | Free sandbox | No | Planned (The store's own videos and how they perform) |
| TikTok Ads | R | Public API | Free sandbox | No | Planned (Ad spend and results from TikTok's API for Business. No public API changelog found; the nightly sandbox run catches API changes) |
| Yext | R | Public API | Free sandbox | No | Planned (Local listings and reviews from many sites in one place, including Yelp, whose own API shows only a few reviews. No public API changelog found; the nightly sandbox run catches API changes) |
| Docusign | R, W, M | Public API | Free sandbox | Yes | Planned (Signed appraisal, consignment, memo and custom order agreements, and who has yet to sign) |
| Dropbox | R, W, M | Public API | Free sandbox | Yes | Planned (Files such as invoices, appraisals and design files. Dropbox publishes no API changelog; changes are announced on its developer blog) |
| Microsoft OneDrive and SharePoint files | R, W, M | Public API | Free sandbox | Yes | Planned (Files kept in OneDrive or SharePoint, read through Microsoft Graph, whose one changelog is watched through the Outlook entry) |
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
| Affirm | R | Public API | Free sandbox | Yes | Built (Read-only, though an Affirm key pair can't be limited to reading: the connector only sends GET requests for transactions, disputes and settlements. US accounts only for now. The docs watch follows the API changelog, and the nightly sandbox run catches API changes) |
| Synchrony | R | Partner | Partner | No | Planned |
| Acima | R | Partner | Partner | No | Planned |
| Jewelers Board of Trade | W, M | Partner | Partner | No | Planned (Trade credit ratings) |
| Avalara AvaTax | R, W, M | Public API | Free sandbox | No | Planned (Sales tax by jurisdiction. No public AvaTax changelog; the nightly sandbox run catches API changes) |
| TaxJar | R, W | Public API | Unknown | No | Planned |
| FinCEN Form 8300 cash reporting | R, W, M | File export | Sample files | No | Planned (Cash payments over $10,000; filed through BSA E-Filing, which has no API, so the brain prepares and tracks filings) |
| Refiner and scrap settlement statements | R, W, M | File export | Sample files | No | Built (CSV exports from any refiner, and PDF statements from a refiner whose layout is in its profile) |
| Gusto | R, W, M | Public API | Free sandbox | Yes | Planned (Payroll, commissions and staff costs) |
| LeadsOnline secondhand reporting | R | Partner | Partner | No | Planned (Gold and secondhand buys many US police departments require; LeadsOnline issues API credentials to point-of-sale partners) |
| BILL | R, W, M | Public API | Free sandbox | Yes | Planned (Supplier bills, approvals and vendor payments) |
| Ramp | R, W, M | Public API | Unknown | Yes | Planned (Company card spending, receipts, reimbursements and bills) |
| Klarna | R | Public API | Unknown | No | Planned (Pay-over-time orders, captures, refunds and settlement reports) |
| Afterpay | R | Public API | Partner | No | Planned (Pay-over-time orders, refunds and settlements; sandbox credentials come from an Afterpay account manager) |
| cardONE Fintech | R | Unknown | Unknown | No | Planned (Payments and financing for jewelers; product still being confirmed. No API found. Exhibited at JCK 2026) |
| American First Finance | R | Partner | Partner | No | Planned (Consumer financing and lease-to-own: applications, funded contracts and settlements. Merchant partner only. Exhibited at JCK 2026) |
| Aurora Payments | R | Unknown | Unknown | No | Planned (Merchant card processing: transactions, batches, deposits and fees. No API confirmed; start with statements. Exhibited at JCK 2026) |
| Sola Payments (formerly Cardknox) | R, W | Public API | Free sandbox | No | Planned (Payment gateway: transactions, customers and recurring schedules for layaways. Public API with a free sandbox. No public API changelog found; the nightly sandbox run catches API changes. Exhibited at JCK 2026) |
| Wells Fargo Jewelry Advantage | R | File export | Paid account | No | Planned (Consumer financing program for jewelers. No API; start with merchant summary report exports. Exhibited at Centurion) |
| OWL Financial Group | R, W, M | Unknown | Unknown | No | Planned (Collateral loans for jewelers and the pledged pieces behind them. No API found. Exhibited at Centurion) |

### Manufacturing and wholesale operations

| Integration | Used by | Access | Test with | Webhooks | Status |
| --- | --- | --- | --- | --- | --- |
| PIRO | W, M | EDI | Sample files | No | Planned |
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
| ShipStation | R, W | Public API | Paid account | Yes | Planned (Shipments, labels, insured values and tracking across carriers. API access needs a Gold plan or above) |
| FedEx | R, W, M | Public API | Free sandbox | Yes | Planned (Tracking, declared values and delivery exceptions; tracking webhooks need an enterprise shipping account) |
| UPS | R, W, M | Public API | Free sandbox | No | Planned (Tracking, declared values and delivery exceptions for parcels sent to customers and vendors) |
| USPS | R, W, M | Public API | Free sandbox | Yes | Planned (Tracking for Registered Mail and other USPS parcels, with tracking event subscriptions. USPS publishes no changelog for its new APIs) |
| NetSuite | W, M | Public API | Paid account | No | Planned (ERP for wholesalers and manufacturers: items, orders, purchase orders and the books. Release notes are published per release, so the nightly sandbox run catches API changes) |
| Katana | M | Public API | Unknown | Yes | Planned (Manufacturing orders, materials, stock and costs for small makers) |
| Cin7 Core | R, W, M | Public API | Paid account | Yes | Planned (Inventory, purchasing and sales across channels; webhooks need the Automation module) |
| RightClick | W, M | Unknown | Partner | No | Planned (Cloud ERP for jewelry manufacturers and wholesalers: stock, bills of materials, job bags and costing. No public API; partner only. Exhibited at JCK 2026) |
| e-Jewelry for Business Central | R, W, M | Public API | Paid account | No | Planned (Jewelry ERP on Microsoft Dynamics 365 Business Central: items, memos, production and sales documents. Reached through the tenant's Business Central APIs on a paid account. Exhibited at JCK 2026) |
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
| RFID and barcode tray counts | R, W, M | File export | Sample files | No | Planned (Tray and case scan exports, so the nightly count is checked against what should be there) |
| Homebase | R | Partner | Partner | No | Planned (Staff schedules and time clock, so labor can be set against sales. API keys need the Enterprise plan and a request to Homebase support) |
| Deputy | R, W, M | Public API | Unknown | Yes | Planned (Staff rosters and timesheets, so labor can be set against sales or bench work) |
| Asana | R, W, M | Public API | Free sandbox | Yes | Planned (Tasks and projects used to track repairs, custom orders and buying trips) |
| Trello | R, W, M | Public API | Free sandbox | Yes | Planned (Boards and cards used to track repairs, custom orders and buying) |
| Airtable | R, W, M | Public API | Free sandbox | Yes | Planned (Bases many stores use for memo logs, repair intake and custom order tracking) |
| Notion | R, W, M | Public API | Free sandbox | Yes | Planned (Databases and pages used for job tracking, procedures and buying notes) |
| Verkada store traffic | R | Public API | Paid account | Yes | Planned (People counts from store cameras, to compare footfall with sales) |
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
| RepairShopr | R | Unknown | Paid account | No | Planned (Repair ticketing used by watch repair shops. API access not yet confirmed. Found in luxury watch trade research) |

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
- BigCommerce's v2 order and store paths and v3 catalog, inventory, customer, refund and price list paths
- Clover's REST API v3 read endpoints with its v2 OAuth token refresh, including its 90-day cap on orders, payments and refunds
- Typeform's Create API (a form's definition) and Responses API
- GIA's Report Results API: getReport and getChangedReports
- Gmail's message, label and history reads with Google's token refresh (API v1)
- Google Drive (files and changes, v3), Sheets (`values:batchGet`, v4) and Calendar (`events.list` with sync tokens, v3) with Google's token refresh, enforcing each API's documented scopes so `drive.metadata.readonly` can't read Sheets values
- HubSpot's CRM search, archived list, batch association and token info endpoints (date version 2026-09)
- IDEX's Onsite feeds: the natural full feed and the lab-grown full file
- Klaviyo's mock covers its profile, list, segment, campaign, flow and metric reads and the campaign and flow values reports (revision 2026-10-15). Plaid's accounts, transactions sync, Item and webhook verification key endpoints (API version 2020-09-14), with webhooks signed the way Plaid signs them
- monday.com's GraphQL API: boards, items, activity logs and updates
- Nivoda's GraphQL diamond search: sign-in, diamonds_by_query and get_diamond_by_id
- Plaid's accounts, transactions sync, Item and webhook verification key endpoints (API version 2020-09-14), with webhooks signed the way Plaid signs them
- QuickBooks Online's query and change data capture endpoints with Intuit's token refresh (minor version 75)
- Rapaport's token service and Price List API: the full list and its changes
- Slack's auth.test, conversations.list, conversations.history and conversations.replies, with both rate-limit regimes (Web API)
- Square's read endpoints with its OAuth refresh and token status check (API version 2026-09-16)
- Stuller's invoice and metal market rate endpoints (API v2)
- A Wix site's read endpoints (eCommerce orders, Catalog V3 and V1, Contacts V5) with the app token, its permissions and cursor paging
- A WooCommerce store's REST API v3 read endpoints with its key permissions and page headers
- Xero's Accounting API endpoints with its token refresh

Where a vendor has a free sandbox (Affirm, Authorize.net, BigCommerce, Clover, Custom forms, GIA Report Results, Gmail, Google Workspace and Drive, HubSpot, Klaviyo, Monday.com, Plaid, QuickBooks Online, Slack, Square, Wix, WooCommerce and Xero so far), its mock is a stand-in until a developer account is set up for the nightly run.

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

<!-- registry:connector-docs:end -->

## Writing back: built, turned off

Every connector starts read-only. A connector may declare the write actions it could perform (`writes` on `Connector`), such as adjusting Shopify stock or creating a QuickBooks invoice, but each one runs through a `WriteGate`:

- The gate refuses any action the instance has not listed in `ENABLED_WRITES`, which is empty by default. Entries are `integration:action`, or `integration:*` for every action of one integration.
- Every attempt is audited, whether it was refused, performed or failed, with who asked for it.
- Connectors request only read scopes from vendors until a client agrees to writes.

So write support can be built and tested now, and switched on per client and per action later.
