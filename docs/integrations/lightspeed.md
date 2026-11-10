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
