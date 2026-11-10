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
