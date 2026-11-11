### NetSuite

Reads a wholesaler's or manufacturer's NetSuite account: items, vendors, sales and purchase orders, invoices, journal entries and stock by location, so finance, buying and inventory see the whole ERP next to retail and memo. Books arrive in the same `accounting.*` events the QuickBooks and Xero connectors give.

| Setting | What it is |
| --- | --- |
| `NETSUITE_ACCOUNT_ID` | The account id, such as `1234567` or `1234567_SB1` |
| `NETSUITE_CLIENT_ID` | The client id of the integration record made for KaratOS |
| `NETSUITE_CERTIFICATE_ID` | The certificate id NetSuite gives when the certificate is mapped |
| `NETSUITE_PRIVATE_KEY` | The certificate's private key, as PEM or base64-encoded PEM |

**Read-only by design.** The connector signs in by OAuth 2.0 machine-to-machine (client credentials): it signs a JWT with the certificate's private key and swaps it for an access token that lasts an hour. The token carries the permissions of the role the certificate is mapped to, so the setup asks the administrator for a role that can only view items, vendors, locations and the four kinds of transaction read, with REST Web Services and OAuth 2.0 log-in. It asks only for the `rest_webservices` scope, and sends only two requests to the account's SuiteTalk host: one for a token, and SuiteQL queries, which can only read. The five queries are fixed in the client with only bound parameters. Creating a sales order or a purchase order is declared behind the write gate, each needing approval, turned off, and the client has no request to send them. NetSuite blocks new token-based (TBA) integrations from 2027.1, so the connector doesn't use TBA.

**What it reads.** SuiteQL reads each list oldest change first, 1,000 rows a page by offset, and a query reads 100,000 rows at most. The first import reads every item and vendor, the transactions of the last six years (sales orders, purchase orders, customer invoices and journal entries), then stock by location. Each later sync reads what changed since the newest change the last one saw, less ten minutes, and stock by location again; the first later sync looks back three days. A pass that reaches 100,000 rows starts again from the newest change it saw. NetSuite writes times in the account's time zone, so the marks are kept as NetSuite wrote them, and a start worked out from KaratOS's clock reaches back a day further. A row read again unchanged is a duplicate. Each page is one batch, and the checkpoint keeps the list, its start, the next offset and the newest change seen.

**Events.**
- `accounting.item_updated` for each item: its sku, name, kind and whether it is active.
- `accounting.vendor_updated` for each vendor: its company name, currency and whether it is active. A vendor who is a person is named only by NetSuite id.
- `accounting.sales_order_updated`, `accounting.purchase_order_updated`, `accounting.invoice_updated` and `accounting.journal_entry_updated` for each transaction: its number, customer or vendor, date, due date, total and what is still owed in whole cents, currency and status.
- `inventory.counted` for each item at each location: on hand, available, committed, on order and back ordered.

Every event keeps the row's change time as NetSuite wrote it (`changedAt`) and is dated when it was read. A row without an id or a change time, a transaction of another kind, or stock on hand that isn't a count of zero or more is dead-lettered.

**Privacy.** No addresses, phone numbers, email addresses, memos or people's names are read: the queries don't select them.

**Rate limits.** NetSuite limits concurrent requests per account. The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 500, 502, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. A 400 or 401 on sign-in says the client id, certificate or key is wrong or the certificate has expired; a 403 on a query says the role can't view that list. A token turned down mid-sync is replaced once.

**Testing.** The tests run against a mock built from NetSuite's developer docs (`packages/testkit/src/mocks/netsuite.ts`). It checks each JWT's header, claims and signature against the certificate, the `Prefer: transient` header, the bound start, the page size and that every offset is a multiple of it. The first client's account must confirm: that the four transaction type codes and `aggregateitemlocation` columns read as the docs and community guides describe, the client id and certificate id shapes, and that times come back as `TO_CHAR` writes them.
