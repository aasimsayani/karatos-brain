### Stuller

Reads the invoices on the business's Stuller account and Stuller's current metal market rates. Buying and finance see what was ordered, what it cost, what is still owed and where each shipment is, and the metal prices the invoices were priced at. It needs a Stuller account and a developer login, which a Stuller account owner makes under the Developer role; that login works with the API only and can't sign in to Stuller.com.

| Setting | What it is |
| --- | --- |
| `STULLER_USERNAME` | The developer login's user name |
| `STULLER_PASSWORD` | The developer login's password. It is sent only to `api.stuller.com`, which is fixed in the client |

**What it reads.** Each sync reads every invoice from `GET /api/v2/invoice`, since that endpoint has no date filter, and records the ones that are new or changed since the last sync, oldest first. Invoices dated more than five years back are skipped. It then reads `GET /api/v2/products/metalmarketrates`. A login Stuller turns down (HTTP 401) stops the sync and says to check the login and its Developer role. A 429 waits as Retry-After says, up to a minute, three times.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `vendor_invoice.received` | An invoice new or changed: invoice, order and purchase order numbers, ship-to account number, status, invoice and order dates, order, invoice and due totals, sales tax and shipping in cents, ship method, tracking number, the gold, silver and platinum rates it was priced at, and each line's item number, description, quantities shipped and back-ordered, unit price, line total, labor and other charges, and weight | invoice number and a hash of what was read |
| `vendor_metal_rate.published` | Stuller's current price per troy ounce in cents for gold, silver, platinum and palladium | a hash of the rates |

An invoice is recorded again when its status, tracking or anything else read changes, so a shipment can be followed from order to delivery; unchanged invoices and unchanged rates are not recorded twice. The rates' time is when KaratOS read them, since Stuller's answer carries none. Ship-to addresses and tracking links aren't stored: a drop-shipped order carries the business's customer's address. An invoice without a readable number or date, or with an amount or line that doesn't read, is dead-lettered listing what was wrong; the rest are still read. No department reasons over these events yet.

**Writes.** Declared and turned off: submitting an order to Stuller.

**Testing.** The tests run against a mock built from Stuller's API help pages (`packages/testkit/src/mocks/stuller.ts`), which answers synthetic invoices and rates and turns down a wrong login. It is checked live once a developer login is connected.
