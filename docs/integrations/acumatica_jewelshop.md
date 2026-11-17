### Acumatica JewelShop

Reads a JewelShop business's Acumatica instance through its contract-based REST API (the Default endpoint, version 24.200.001 unless set). Read-only by the user's role and by the client: KaratOS signs in as a user whose role can only view stock items and sales orders, and the client sends only GET requests for those two, besides one POST for a token and one to sign out when a pass ends.

| Setting | What it is |
| --- | --- |
| `ACUMATICA_URL` | The instance's https address, with its path if it isn't at the site root |
| `ACUMATICA_CLIENT_ID` | The connected application's ID, a GUID, an @ and the tenant |
| `ACUMATICA_CLIENT_SECRET` | Its shared secret |
| `ACUMATICA_USERNAME` | The KaratOS user, whose role has View Only on Stock Items and Sales Orders |
| `ACUMATICA_PASSWORD` | That user's password |
| `ACUMATICA_ENDPOINT_VERSION` | Optional: 23.200.001, 24.200.001 (the default), 25.100.001 or 25.200.001 |
| `CUSTOMER_REF_KEY` | Shared: the key customer references are made with |

**What it reads.** Every pass reads all stock items, 500 a page, with their warehouse lines, since what a warehouse has on hand can change without an item's LastModified moving. Then it reads the sales orders modified in its window. The historical import's window reaches back five years. Each later sync's starts a day before the last one ended. A pass reads records modified up to a time fixed when it starts.

**Events.** A stock item becomes `product.updated` (SKU, description, class, status, type, unit, default price in cents). Each warehouse line becomes `inventory.counted` (SKU, on hand, warehouse), dated when it was read. A sales order becomes `order.updated` (type, number, status, date, currency, total in cents, quantity, customer). Each is keyed by its record and a digest of what was kept, so one read again unchanged is a duplicate. A record without an ID or a time that reads is dead-lettered.

**Privacy.** A customer's account code can name the business, so only a reference keyed with `CUSTOMER_REF_KEY` is kept. Order notes, contacts and addresses aren't read.

**Rate limits.** Acumatica limits requests per minute by license and answers 429 once its queue is full. The client waits out a 429, and a 500, 502, 503 or 504, three times, honoring Retry-After up to a minute. A token turned down early gets one fresh sign-in. Signing out at the end of each pass frees the API session the license counts.

**Not yet.** JewelShop's memo in and out and consignment screens aren't on the Default endpoint. Reading them needs an endpoint extension from JewelShop's vendor or the business's Acumatica partner.

**Testing.** The tests run against a mock built from Acumatica's Integration Development Guide (`packages/testkit/src/mocks/acumatica_jewelshop.ts`). It checks the sign-in, the fields, the filter and paging, the role and sign-out. Its assumptions are listed so the first run against a real instance can confirm them.
