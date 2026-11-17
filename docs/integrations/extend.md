### Extend product protection

Reads one store's Extend account through Extend's merchant API, at `https://api.helloextend.com`, or `https://api-demo.helloextend.com` for Extend's demo environment ([getting started](https://docs.extend.com/docs/getting-started-with-extends-api.md)): the product protection plans the store sold, each with the product it covers and the order it was sold on, and the orders Extend holds for the store. Requests send `Accept: application/json; version=2022-02-01`.

| Setting | What it is |
| --- | --- |
| `EXTEND_CLIENT_ID` | The client ID of an API Integration made for KaratOS in the Extend Merchant Portal |
| `EXTEND_CLIENT_SECRET` | That API Integration's client secret |
| `EXTEND_STORE_ID` | The store's ID in Extend, a UUID from the Merchant Portal |
| `EXTEND_ENVIRONMENT` | Optional: `production` (the default) or `demo` |

**Sign-in.** A store admin (or a user with the integrator role) opens the Integration tab of the Extend Merchant Portal, clicks New API Integration, names it KaratOS and, optionally, gives it an expiration date, then copies the client ID and secret ([authentication](https://docs.extend.com/reference/authentication.md)). The demo environment needs its own API Integration from the demo Merchant Portal. The connector trades the ID and secret at `POST /auth/oauth/token` (`grant_type: client_credentials`) for a short-lived token, and sends it in the `X-Extend-Access-Token` header, not as a bearer token. The settings are checked before anything is sent. A token request turned down (400, 401 or 403) stops the sync with a message naming `EXTEND_CLIENT_ID` and `EXTEND_CLIENT_SECRET`; a search turned down (401 after one fresh token, or 403) names `EXTEND_STORE_ID`. Only Extend's error code is kept, never its message.

**What the key can do.** Extend documents no scopes for contracts or orders and says the client ID and secret carry broad privileges: with them, anyone could do whatever Extend's merchant API allows for the store, such as creating, changing or cancelling orders, contracts and line items, and reporting refunds. Read-only is enforced by KaratOS: apart from the token exchange, the client sends only GET requests to the two searches below, with query strings it builds itself, and has no way to send anything else. Keep the secret as carefully as a password.

**What it reads.**

- `GET /contracts/search?sellerId=<store>&typeFilter=pcrs&showAll=true`: every product protection contract of the store ([search contracts](https://docs.extend.com/reference/contractssearch.md)). Shipping protection contracts are left out. Extend documents no paging for this search, so one answer holds every contract.
- `GET /orders/search?storeId=<store>`, page by page: every order of the store ([search orders](https://docs.extend.com/reference/orderssearch.md)). Extend's answer carries `nextPageCursor`; the connector sends it back as `cursor`, and stops if a cursor comes back unchanged.

Neither search filters by time. So the historical import keeps everything it reads and stops for good. Each later sync reads everything again but keeps only what Extend updated since a day before the last pass started (the first time, in the last 30 days); what is older was kept before. Each read is a batch, and the checkpoint keeps Extend's order cursor, so a sync that stops resumes at the same page. A 429 (or a 500, 502, 503 or 504) is retried three times, honoring `Retry-After` up to a minute or else waiting 1, 2 and 4 seconds, before the sync stops and resumes from its checkpoint.

Service orders and claims aren't read: Extend's service order search needs a claim ID or service order ID ([service orders](https://docs.extend.com/reference/get_service-orders-search.md)), and the docs show no way to list a store's claims.

**Events.**

- `warranty.contract_updated` for each version of a contract: its status (created, live, delivered, expired, fulfilled, cancelled, a refund status, voided, pending termination or terminated) and whether it still covers the product, the plan's id, category, term and service type, the coverage status, start and end, the plan's purchase and list price in the currency's smallest unit, when it was bought, cancelled or refunded and why it was cancelled, the order and merchant transaction it was sold on, and the covered product's reference ID, name, prices, purchase and fulfillment dates and manufacturer's warranty in months. No connector read protection plans before, so the type follows the `<domain>.<record>_updated` shape of `repair.ticket_updated`.
- `order.updated` for each version of an order: its status, whether it was cancelled or refunded, the merchant transaction, the product, shipping, tax, shipping tax, discount and total amounts, the currency and the line count. The store's own commerce system already reports the sale, so no `sale.completed` is made here.

Each is keyed by its record and a digest of what was kept. No customer name, email, phone or address is kept, nor the gift recipient, the refund recipient, the customer portal link or the product's serial number. A merchant customer ID is kept only when it reads as an ID. Extend's contract times are 13-digit epoch milliseconds and its order example is 10-digit seconds, so both are read. A contract or order that doesn't read is dead-lettered with what was wrong, never guessed.

**Writes.** Cancelling an order is declared behind the write gate, needing approval each time and at most five a day, and turned down while writes are off. The client has no way to send it.

**Testing.** The mock (`packages/testkit/src/mocks/extend.ts`) is built from Extend's API reference, and its assumptions list what the first live run must confirm: the token answer's shape, that the order search takes `cursor`, that the contract search has no paging, the order time unit and that money is in the smallest unit.
