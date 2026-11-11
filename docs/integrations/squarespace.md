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
