# Integrations

The catalog lives in code at [`packages/core/src/integrations.ts`](../packages/core/src/integrations.ts). The first entries come from the original Brain A Integration Mapping sheet; the rest cover the wider stack that jewelry retailers, wholesalers and manufacturers run. A built connector's own catalog fields (status, note, capabilities and anything else it settles) are in `packages/core/src/catalog/<id>.ts`, next to nothing else. Tests check two things: every setting an integration needs is documented in [`secrets/manifest.json`](../secrets/manifest.json), and every integration appears in the tables below, which are generated from the catalog by `npm run registry:write`.

`integrationsFor("retail" | "wholesale" | "manufacturing")` returns the systems a given kind of business is likely to run, which is where onboarding starts.

## Build order: self-serve first

The first phase builds every integration we can finish without asking any vendor, company or person for anything: a public API with a free developer sandbox, or a file or EDI format we can test with synthetic samples. `selfServeIntegrations()` returns that list (67 systems today). Systems that need a paid subscription, a trade account or a partnership come later, once the core is built out.

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
| Square | R | Public API | Free sandbox | Yes | Planned |
| Clover | R | Public API | Free sandbox | Yes | Planned |
| Valigara | R, W, M | Unknown | Unknown | No | Planned |
| WooCommerce | R | Public API | Free sandbox | Yes | Planned |
| BigCommerce | R, W | Public API | Free sandbox | Yes | Planned |
| Wix | R | Public API | Free sandbox | Yes | Planned |
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
| Metals-API | R, W, M | Public API | Free sandbox | No | Planned (No public API changelog; the nightly sandbox run catches API changes) |
| Tenoris | R, W, M | Partner | Partner | No | Planned (Category and price-point sales benchmarks from independent jewelers. Partner only. Found in jewelry industry sources) |
| Edge Retail Academy and Edge Pulse | R | Partner | Partner | No | Planned (Peer KPI benchmarks, inventory aging, turn and open-to-buy guidance. Partner only. Exhibited at Centurion) |
| TheWatchSearch (by TheWatchCloud) | R, W | File export | Sample files | No | Planned (Live offers and wanted lists from dealer WhatsApp groups. No API, so it starts from WhatsApp group chat exports the store already has; a partner feed from TheWatchCloud comes later) |
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
| Refiner and scrap settlement statements | R, W, M | File export | Sample files | No | Planned (CSV or PDF from the refiner) |
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
| EDI with retail partners (X12 850, 855, 856, 810, 846, 852) | W, M | EDI | Sample files | No | Planned (Purchase orders, ship notices, invoices, inventory and sell-through) |
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
| Sales and POS | Shopify, Inventory and POS systems, Stripe, HubSpot, Monday.com, Slack, Instagram DMs, Facebook Messenger and WhatsApp Business, The Edge (Abbott Jewelry Systems), Jewel360, ARMS, Lightspeed Retail, Square, Clover, Valigara, WooCommerce, BigCommerce, Wix, Punchmark, Clientbook, Podium, Authorize.net, Affirm, Synchrony, Acima, EDI with retail partners (X12 850, 855, 856, 810, 846, 852), Jewelers Mutual care plans, Google Analytics 4, Etsy, eBay, Microsoft Teams, RingCentral, Quo (formerly OpenPhone), Zoom, Gorgias, Zendesk, Apple Messages for Business, Pinterest, Amazon (Selling Partner API), TikTok Shop, Faire, NuORDER, JOOR, Squarespace Commerce, BriteCo jewelry insurance, Extend product protection, ShipStation, Cin7 Core, Klarna, Afterpay, Homebase, Deputy, Verkada store traffic, Luxare, RightClick, e-Jewelry for Business Central, The Jewelry Shopkeeper, Clarity Point of Sale, Lashbrook Builder, Gemist Designer, JewelMate Enterprise Retail, CaratIQ, Caratwise, cardONE Fintech, Cabrella Shipping Insurance, American First Finance, Aurora Payments, Sola Payments (formerly Cardknox), Wells Fargo Jewelry Advantage, Smart Age Solutions (SEO Genie, Smart Care app), Thinkspace, Reshyne, Jewelry Sales Academy, DCA Learning, Sarine (Profile, Diamond Journey and report verification), Uploadify, Flawless POS, Crystal, Guild Jeweler, wJewel, ChainDrive, Gem Logic, Instappraise, JM Shipping Solution, Tenoris, KaratCare: Jewelry Repairs, Whatnot Seller API, Diamond Relations CRM, GemFlow, BIG Network (Balance to Buy and SalesRep Direct), Perfect Corp Jewelry Virtual Try-On API, Kickflip jewelry configurator, Custom Ring Builder, Keyideas RingBuilder, TheWatchSearch (by TheWatchCloud), Search The Watch Market Business API, ElixIQ.io (formerly WatchFind.io), Chrono24 dealer inventory feed, WatchCharts API, WatchBase Data Feed, EveryWatch, Elefta, WatchTraderHub, Chronodesk, WatchManager.app, Loupe for Dealers, Bezel seller portal, Grailzee, Wristcheck, The 1916 Company (WatchBox), Jomashop vendor integration, WatchCharts Marketplace, Wholesalr.io, RepairDesk, Zillion watch insurance, Lavalier, WristBook |
| Inventory and Merchandising | Shopify, Inventory and POS systems, The Edge (Abbott Jewelry Systems), Jewel360, ARMS, Lightspeed Retail, Square, Clover, Valigara, WooCommerce, BigCommerce, Wix, Punchmark, RapNet and the Rapaport Price List, IDEX Online, Nivoda, VDB (Virtual Diamond Boutique), Polygon, Stuller, GemFind JewelCloud, Quality Gold, GIA Report Results, IGI report verification, PIRO, Adaptive Jewelry ERP, Acumatica JewelShop, DiamTrade, EDI with retail partners (X12 850, 855, 856, 810, 846, 852), Parcel Pro, Malca-Amit, Etsy, eBay, Amazon (Selling Partner API), TikTok Shop, Faire, NuORDER, JOOR, Squarespace Commerce, HRD Antwerp report check, GCAL report verification, Supplier invoices and memos, Overnight Mountings, RFID and barcode tray counts, ShipStation, FedEx, UPS, USPS, NetSuite, Katana, Cin7 Core, Airtable, Luxare, RightClick, e-Jewelry for Business Central, The Jewelry Shopkeeper, Clarity Point of Sale, Laravo, JewelMate Enterprise Retail, Unbridaled OS, CaratIQ, Thinkspace, DiaTrue detectors, DRC Guardian, Sarine (Profile, Diamond Journey and report verification), Gübelin Report Verification, GSI report access, Tracr, Uploadify, Flawless POS, Crystal, Guild Jeweler, wJewel, ChainDrive, Bransom bsmart-links, Gem Logic, Edge Retail Academy and Edge Pulse, GemIQ (GemLightbox and GemStudio), Vision360 (v360), Diatech Marketplace, GemCloud and Gemolith, Whatnot Seller API, BIG Network (Balance to Buy and SalesRep Direct), Get-Diamonds, LGDeal, OWL Financial Group, Yehuda Sherlock Holmes / Watson AI, Custom Ring Builder, Keyideas RingBuilder, TheWatchSearch (by TheWatchCloud), Search The Watch Market Business API, ElixIQ.io (formerly WatchFind.io), Chrono24 dealer inventory feed, WatchCharts API, WatchBase Data Feed, Elefta, WatchTraderHub, Chronodesk, WatchManager.app, Loupe for Dealers, Bezel seller portal, Grailzee, Jomashop vendor integration, WristBook |
| Clienteling and CRM | Shopify, Inventory and POS systems, Stripe, HubSpot, Custom forms, Gmail, Instagram DMs, Facebook Messenger and WhatsApp Business, The Edge (Abbott Jewelry Systems), Jewel360, ARMS, Lightspeed Retail, Square, Clover, Clientbook, Podium, Birdeye, Klaviyo, Twilio, Calendly, Acuity Scheduling, Mailchimp, Google Business Profile, Microsoft 365 Outlook mail and calendar, Any other mailbox (IMAP), RingCentral, Quo (formerly OpenPhone), Zoom, Gorgias, Zendesk, Apple Messages for Business, Postscript, Yotpo reviews and loyalty, Judge.me, Smile.io, Trustpilot, Yext, Squarespace Commerce, BriteCo jewelry insurance, Extend product protection, Luxare, The Jewelry Shopkeeper, JewelMate Enterprise Retail, CaratIQ, Caratwise, Flawless POS, Crystal, Guild Jeweler, wJewel, Instappraise, Zing by Jewelers Mutual (appraisals, claims and diamonds), Diamond Relations CRM, GemFlow, BIG Network (Balance to Buy and SalesRep Direct), Chronodesk, WatchManager.app, RepairDesk, RepairShopr, Zillion watch insurance, Lavalier, Wax Collect (Chubb), WristBook |
| Repairs and Service | Monday.com, Custom forms, Slack, The Edge (Abbott Jewelry Systems), Jewel360, ARMS, Lightspeed Retail, Square, Clover, Stuller, Geller's Blue Book, Twilio, Jewelers Mutual care plans, Parcel Pro, Malca-Amit, Calendly, Acuity Scheduling, Microsoft 365 Outlook mail and calendar, Any other mailbox (IMAP), Microsoft Teams, RingCentral, Quo (formerly OpenPhone), Gorgias, Zendesk, Extend product protection, FedEx, UPS, USPS, Asana, Trello, Airtable, Notion, Luxare, The Jewelry Shopkeeper, Clarity Point of Sale, JewelMate Enterprise Retail, CaratIQ, Reshyne, Jewelers' Toolbox and Benchtrax, Flawless POS, Crystal, Guild Jeweler, wJewel, Gem Logic, KaratCare: Jewelry Repairs, eLUXE3D scanning, The Watch Register, Elefta, RepairDesk, RepairShopr |
| Custom and Special Orders | Monday.com, Custom forms, Gmail, Slack, Stuller, Quality Gold, Calendly, Acuity Scheduling, MatrixGold CAD, Formlabs 3D printing, Microsoft 365 Outlook mail and calendar, Any other mailbox (IMAP), Microsoft Teams, Zoom, Overnight Mountings, Asana, Trello, Airtable, Notion, Docusign, Dropbox, Microsoft OneDrive and SharePoint files, Lashbrook Builder, Gemist Designer, Caratwise, BLNG AI, Jewelers' Assist (RingOS, JewelAR and STL Master), Jewelers' Toolbox and Benchtrax, Master Casting and Cad order system, Crystal, iJewel3D, 3Design CAD, RhinoArtisan, TiaraCAD, eLUXE3D scanning, Kickflip jewelry configurator, Custom Ring Builder, Keyideas RingBuilder |
| Appraisals | RapNet and the Rapaport Price List, IDEX Online, Nivoda, VDB (Virtual Diamond Boutique), GIA Report Results, IGI report verification, GemGuide Appraisal Software, HRD Antwerp report check, GCAL report verification, BriteCo jewelry insurance, Docusign, The Jewelry Shopkeeper, JewelMate Enterprise Retail, Gübelin Report Verification, Flawless POS, Guild Jeweler, wJewel, Gem Logic, Instappraise, Zing by Jewelers Mutual (appraisals, claims and diamonds), Search The Watch Market Business API, WatchCharts API, EveryWatch, Subdial price data, WatchAnalytics |
| Buying, Vendors and Memo | Gmail, RapNet and the Rapaport Price List, IDEX Online, Nivoda, VDB (Virtual Diamond Boutique), Polygon, Stuller, GemFind JewelCloud, Quality Gold, GIA Report Results, nFusion Solutions metals feed, Metals-API, Jewelers Board of Trade, Adaptive Jewelry ERP, Acumatica JewelShop, DiamTrade, Microsoft 365 Outlook mail and calendar, Any other mailbox (IMAP), LeadsOnline secondhand reporting, HRD Antwerp report check, GCAL report verification, Supplier invoices and memos, Overnight Mountings, BILL, Ramp, NetSuite, Katana, Cin7 Core, Asana, Trello, Airtable, Notion, Laravo, Gemist Designer, Brink's Global Services, DiaTrue detectors, DRC Guardian, Sarine (Profile, Diamond Journey and report verification), Gübelin Report Verification, GSI report access, Tracr, ChainDrive, Bransom bsmart-links, Zing by Jewelers Mutual (appraisals, claims and diamonds), Tenoris, Edge Retail Academy and Edge Pulse, Diatech Marketplace, GemCloud and Gemolith, BIG Network (Balance to Buy and SalesRep Direct), Get-Diamonds, LGDeal, Yehuda Sherlock Holmes / Watson AI, Hoover & Strong (refining and myAuction), TheWatchSearch (by TheWatchCloud), Search The Watch Market Business API, ElixIQ.io (formerly WatchFind.io), WatchCharts API, The Watch Register, Art Loss Register, EveryWatch, Chrono24 ChronoPulse index, Subdial price data, WatchAnalytics, Loupe for Dealers, Wristcheck, The 1916 Company (WatchBox), Wholesalr.io, WorldWatch Market |
| Metals and Gold Buying | nFusion Solutions metals feed, Metals-API, Refiner and scrap settlement statements, LeadsOnline secondhand reporting, e-Jewelry for Business Central, Jewelers' Toolbox and Benchtrax, Gem Logic, Hoover & Strong (refining and myAuction) |
| Marketing | Shopify, Inventory and POS systems, HubSpot, Instagram DMs, Facebook Messenger and WhatsApp Business, Valigara, WooCommerce, BigCommerce, Wix, Punchmark, GemFind JewelCloud, Podium, Birdeye, Klaviyo, Attentive, Twilio, Mailchimp, Google Analytics 4, Google Ads, Meta Ads, Google Business Profile, Etsy, Postscript, Yotpo reviews and loyalty, Judge.me, Smile.io, Trustpilot, Pinterest, TikTok, TikTok Ads, Yext, TikTok Shop, Squarespace Commerce, Verkada store traffic, Laravo, Amptive, Smart Age Solutions (SEO Genie, Smart Care app), Thinkspace, Uploadify, Flawless POS, GemIQ (GemLightbox and GemStudio), Vision360 (v360), iJewel3D, Whatnot Seller API, Perfect Corp Jewelry Virtual Try-On API, Chrono24 dealer inventory feed, WatchBase Data Feed, Chrono24 ChronoPulse index |
| Finance | Stripe, Chase business bank accounts and credit cards, Bank and credit card statements (any bank), Google Workspace and Drive, QuickBooks Online, Xero, Plaid, Authorize.net, Affirm, Synchrony, Acima, Jewelers Board of Trade, Avalara AvaTax, TaxJar, Refiner and scrap settlement statements, Gusto, Amazon (Selling Partner API), Supplier invoices and memos, BILL, Ramp, NetSuite, Klarna, Afterpay, Homebase, Deputy, Dropbox, Microsoft OneDrive and SharePoint files, RightClick, e-Jewelry for Business Central, The Jewelry Shopkeeper, cardONE Fintech, Cabrella Shipping Insurance, American First Finance, Aurora Payments, Sola Payments (formerly Cardknox), Wells Fargo Jewelry Advantage, Crystal, JM Shipping Solution, Edge Retail Academy and Edge Pulse, OWL Financial Group, Hoover & Strong (refining and myAuction), Chronodesk, WatchManager.app, WristBook |
| Compliance | Chase business bank accounts and credit cards, Bank and credit card statements (any bank), Google Workspace and Drive, QuickBooks Online, Xero, Plaid, Jewelers Mutual care plans, Parcel Pro, Malca-Amit, Avalara AvaTax, TaxJar, FinCEN Form 8300 cash reporting, Gusto, LeadsOnline secondhand reporting, Supplier invoices and memos, RFID and barcode tray counts, ShipStation, FedEx, UPS, USPS, Docusign, Dropbox, Microsoft OneDrive and SharePoint files, Cabrella Shipping Insurance, Brink's Global Services, DCA Learning, DiaTrue detectors, DRC Guardian, Tracr, Yehuda Sherlock Holmes / Watson AI, JM Alarm Response Program (with Securitas), The Watch Register, Art Loss Register |
| Manufacturing (planned) | PIRO, Adaptive Jewelry ERP, Acumatica JewelShop, DiamTrade, MatrixGold CAD, Formlabs 3D printing, NetSuite, Katana, Deputy, Luxare, RightClick, e-Jewelry for Business Central, Unbridaled OS, BLNG AI, Jewelers' Assist (RingOS, JewelAR and STL Master), Jewelers' Toolbox and Benchtrax, Master Casting and Cad order system, Asiga Composer, 3Design CAD, RhinoArtisan, TiaraCAD, eLUXE3D scanning |
| Wholesale (planned) | RapNet and the Rapaport Price List, IDEX Online, Nivoda, VDB (Virtual Diamond Boutique), Polygon, GemFind JewelCloud, Jewelers Board of Trade, PIRO, Adaptive Jewelry ERP, Acumatica JewelShop, DiamTrade, EDI with retail partners (X12 850, 855, 856, 810, 846, 852), Faire, NuORDER, JOOR, NetSuite, Cin7 Core, Docusign, Luxare, RightClick, e-Jewelry for Business Central, Unbridaled OS, Brink's Global Services, Uploadify, Flawless POS, Gem Logic, Vision360 (v360), Diatech Marketplace, BIG Network (Balance to Buy and SalesRep Direct), Get-Diamonds, Elefta, Jomashop vendor integration, Wholesalr.io, WorldWatch Market |

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
- Plaid's accounts, transactions sync, Item and webhook verification key endpoints (API version 2020-09-14), with webhooks signed the way Plaid signs them
- QuickBooks Online's query and change data capture endpoints with Intuit's token refresh (minor version 75)
- Stuller's invoice and metal market rate endpoints (API v2)
- Xero's Accounting API endpoints with its token refresh

Where a vendor has a free sandbox (Affirm, Authorize.net, Plaid, QuickBooks Online and Xero so far), its mock is a stand-in until a developer account is set up for the nightly run.

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
