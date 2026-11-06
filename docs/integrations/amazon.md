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
