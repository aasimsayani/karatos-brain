### Cin7 Core

Reads the brand's Cin7 Core products, customers, suppliers, sales, purchases and stock at each location, so wholesale, buying and inventory see the stock Cin7 Core runs next to retail and marketplace sales.

| Setting | What it is |
| --- | --- |
| `CIN7_ACCOUNT_ID` | The Cin7 Core account id shown with the API application |
| `CIN7_APPLICATION_KEY` | The key of the API application made for KaratOS |

**Read-only by design.** Cin7 Core signs a call in by the account id and an API application's key, and its docs describe no way to limit what an application can do: the key could also change stock and post orders. So the client is what keeps KaratOS to reading: it sends only GETs of six lists to `https://inventory.dearsystems.com/ExternalApi/v2`, with parameters it builds itself from checked values. Use a separate API application for KaratOS, so it can be deleted without touching any other integration. Adjusting stock and creating a purchase order are declared behind the write gate, each needing approval, turned off, and the client has no request to send them.

**What it reads.** Cin7 Core filters products, customers and suppliers by when they were modified and sales and purchases by when they were updated, pages by number up to 1,000 at a time, and doesn't say what order a page comes in. So a pass reads a list from a time to its end, and the next sync starts from when that pass began, less ten minutes: a record that changed while the pass was reading is read again then. The first import reads every product, customer and supplier (deprecated ones too), the sales and purchases updated in the last five years, and the stock. Each later sync reads what changed since the last pass of each list began, less ten minutes, and the stock whole; the first later sync looks back three days. A record read again unchanged is a duplicate. Each page is one batch, and the checkpoint keeps the list, its start, the next page and when the pass began, so a resumed sync goes on from that page.

**Events.**
- `product.updated` for each product: its sku, name, category, brand, kind, unit, first price tier and average cost in cents, and whether it is active.
- `customer.profile_updated` for each customer and `accounting.vendor_updated` for each supplier: the name, currency and whether they are active.
- `order.updated` for each sale and `accounting.purchase_order_updated` for each purchase: the order and invoice numbers, the customer or supplier, the status, the order, invoice, due and required-by dates, the total, what is paid and what is still owed in cents, and the currency.
- `inventory.counted` for each product at each location, and each bin and batch where Cin7 Core splits stock by them: on hand, allocated, available and on order.

Cin7 Core writes times in UTC, so a record's event is dated by its change time and a stock count by when it was read. Each event is keyed by a digest of what was kept. A record without an id or a change time, a product without a sku, or stock whose on hand isn't a whole count, is dead-lettered.

**Privacy.** Customers' and suppliers' addresses, contacts, phone numbers and email addresses, and comments, are never read into an event.

**Rate limits.** Cin7 Core allows 60 calls a minute for each API application and answers 503 past that, so the client spaces its calls a second apart. It waits as `Retry-After` says (up to a minute), or 5, 10 and 20 seconds, on a 429, 500, 502, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 or 403 says the account id or key is wrong, or the application was deleted.

**Testing.** Cin7 Core needs a paid account or a trial. The tests run against a mock built from Cin7 Core's help center articles on its API (`packages/testkit/src/mocks/cin7.ts`). It checks both headers, the parameters each list takes, the change filters, deprecated records and the paging. It lists what the first client's account must confirm: the key each list's rows come under, the sale list's id fields, the time format, the shape of the account id and key, and that amounts are in the currency's units.
