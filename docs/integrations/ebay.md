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
