### Katana

Reads a small maker's Katana manufacturing orders and stock, so production sees job costs and material shortages before they hold up an order. Orders arrive as the same `manufacturing.job_updated` events PIRO gives, and stock as `inventory.counted`.

| Setting | What it is |
| --- | --- |
| `KATANA_API_KEY` | An API key from Katana's Settings > API |

**Read-only by design.** Katana's API keys can create and delete records as well as read them, and Katana documents no way to limit one. The client is what keeps KaratOS to reading. It sends only GET requests, only to the manufacturing orders and inventory lists, with query values built from checked ones. Creating a manufacturing order is declared behind the write gate, turned off, and the client has no request to send it. Katana's own error text is never repeated in an error, only the HTTP status.

**What it reads.** A pass reads manufacturing orders 250 to a page, then all of the stock. The first import reads the orders created in the last five years. Each later sync reads the orders changed since an hour before the last pass started, deleted ones included, then the stock again: Katana's stock list has no change filter. Each page is one batch and one checkpoint.

**Events.** `manufacturing.job_updated` for each order, with its status (open, on hold, in progress, completed, or cancelled once deleted), order number, the item, location and sales order it is for, planned and produced quantities, whether its materials are in stock, expected or missing, when it was created, is due, is due for delivery and was done, its total, material, subassembly and operations costs in cents, and planned and actual time. `inventory.counted` for each item at each location, with its SKU, name, whether it is a product or a material, and the quantities in stock, committed, expected and missing or in excess, the reorder point, and the average cost and value in cents. Orders are keyed by a digest of what was kept, so an unchanged order is a duplicate. Counts are keyed by the day and what was counted. One without an ID that reads is dead-lettered.

**Privacy.** An order's notes, serial numbers, batches and custom fields aren't kept: they are free text a maker may fill with a customer's name.

**Rate limits.** Katana allows 60 requests a minute. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time.

**Testing.** The tests run against a mock built from Katana's docs (`packages/testkit/src/mocks/katana.ts`). It checks the key, the filters and the paging, and lists what the first run against a real account must confirm: whether the date filters are inclusive, and how a deleted order is listed. Katana has a free trial: an account opened for testing, with synthetic orders and materials, is enough.
