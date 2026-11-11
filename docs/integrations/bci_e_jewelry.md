### e-Jewelry for Business Central

Reads a jeweler's e-Jewelry, which runs on Microsoft Dynamics 365 Business Central: items, vendors, sales invoices and purchase invoices, so finance, buying and inventory see the ERP next to retail and memo. Books arrive in the same `accounting.*` events the NetSuite, QuickBooks and Xero connectors give.

| Setting | What it is |
| --- | --- |
| `EJEWELRY_TENANT_ID` | The Microsoft Entra tenant id of the jeweler's Business Central |
| `EJEWELRY_ENVIRONMENT` | The Business Central environment's name, such as `production` |
| `EJEWELRY_COMPANY_ID` | The id of the company e-Jewelry's data is in |
| `EJEWELRY_CLIENT_ID` | The client id of the Microsoft Entra app registered for KaratOS |
| `EJEWELRY_CLIENT_SECRET` | A client secret of that app |

**Read-only by design.** The connector signs in service to service: it trades the app's client id and secret for a token (client credentials, scope `https://api.businesscentral.dynamics.com/.default`). Microsoft Entra has no read-only permission for Business Central, so what the app can do is set by the permission sets it is given on Business Central's Microsoft Entra Applications page, and the setup asks for read-only ones, never SUPER. The client sends only the token request and GETs of four lists in the one company, each marked `Data-Access-Intent: ReadOnly`, and follows a next link only while it stays on the list being read. Creating a draft sales quote and updating an item are declared behind the write gate, each needing approval, turned off, and the client has no request to send them.

**What it reads.** The first import reads every item and vendor, then the sales and purchase invoices changed in the last five years. Each later sync reads what changed since the newest change the last one saw, less ten minutes; the first later sync looks back three days. Business Central pages each list itself, and each page is one batch. The checkpoint keeps the list, its start, the next link and the newest change seen. A row read again unchanged is a duplicate.

**Events.**
- `accounting.item_updated` for each item: its number as the sku, name, kind, category, whether it is active, unit price and cost in whole cents, units on hand and unit.
- `accounting.vendor_updated` for each vendor: its number, name, currency, what is owed to it and whether it is active (not blocked).
- `accounting.invoice_updated` for each sales invoice: its number, the customer's Business Central id, dates, total, tax and what is still owed, currency and status.
- `accounting.bill_updated` for each purchase invoice: its number, the vendor's id and invoice number, dates, total, tax, currency and status.

Each event is dated when the row last changed, which Business Central writes in UTC. A blank currency is the company's own. A row without an id or a change time, or an item of another kind, is dead-lettered.

**Privacy.** A sales invoice's customer is kept as Business Central's id only: never the name, address, email or phone the invoice carries.

**Not yet.** Memos, jobs and diamond records are e-Jewelry's own pages and tables. e-Jewelry doesn't publish an API for them, so they wait for the first client's tenant to show what it exposes.

**Rate limits.** Business Central allows 6,000 calls in five minutes for a user, so calls are spaced a tenth of a second apart. A 429, 500, 502, 503 or 504 is waited out as `Retry-After` says (up to a minute), or 5, 10 and 20 seconds, before the error goes to the sync runner, which resumes from its checkpoint. A 400 or 401 on sign-in says the client id, secret or tenant is wrong; a 403 on a list says the app's permission sets don't cover it; a 404 says the environment or company is wrong. A token turned down mid-sync is replaced once.

**Testing.** The tests run against a mock built from Business Central's API reference and Microsoft's service-to-service guide (`packages/testkit/src/mocks/bci_e_jewelry.ts`). It checks the sign-in form and scope, the token, the tenant, environment and company in each path, the filter, and that next links keep it. The first client's tenant must confirm that e-Jewelry keeps its items, vendors and invoices in Business Central's standard tables, and how a next link is written.
