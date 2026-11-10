### BILL

Reads a business's supplier bills, their approvals, the vendors it pays and the payments it sends from BILL's v3 API, for the finance and buying departments.

| Setting | What it is |
| --- | --- |
| `BILL_CLIENT_ID` | The client id of a BILL developer app made with accounting data access |
| `BILL_CLIENT_SECRET` | That app's client secret |
| `BILL_ENVIRONMENT` | Optional. `production` (the default) or `sandbox` |

**Sign-in.** BILL's developer apps offer two choices: full access, which can create payments and change funding accounts, and accounting data access, which can't. There is no read-only option, so the app is made with accounting data access and the connector itself only ever reads. The client signs in with OAuth client credentials at `POST /authx/token` (`auth.bill.com`, or `auth.stage.bill.com` for the sandbox), keeps the token until five minutes before its hour runs out, and sends it as a bearer token, with no developer key or session id. A 401 signs in again once.

**What it reads.** `GET /v3/vendors`, `/v3/bills` and `/v3/payments`, in that order, 100 to a page, filtered to records changed at or after the pass's start and sorted by `updatedTime`, oldest first. The checkpoint keeps the list and BILL's page token, so a resumed sync goes on from the page it reached. The historical import reads six years; each later sync asks from the start of the last one, less five minutes, and the overlap comes back as duplicates. BILL allows 3 requests at once for an organization (`BDC_1322`, retried with backoff, as are 429 and 503) and 20,000 an hour (`BDC_1144`, which stops the sync until the next one).

**Events.** The same types the QuickBooks and Xero connectors give:

- `accounting.vendor_updated`: the vendor id, name, whether it's archived, its bill currency and how BILL pays it (ACH, check and so on).
- `accounting.bill_updated`: the bill id, vendor, invoice number and date, due date, total, balance due, amount paid and scheduled in cents, currency, payment status and approval status, and whether it's archived.
- `accounting.payment_updated`: the payment id, vendor, process date, amount in cents and in US dollars, status, method, whether it was made in BILL, and the bills it paid with how much each.

Each is keyed by record, id and `updatedTime`, so each change is stored once. A record with no readable id or time is dead-lettered. Vendor email addresses, phone numbers, street addresses, account numbers, tax ids and bank details, payment card digits, check numbers and confirmation numbers, and bill and payment descriptions are never kept.

**Writes.** None. KaratOS never pays, approves, voids or changes anything in BILL. BILL doesn't send webhooks to apps that sign in this way, so the connector reads on each sync.

**Testing.** The mock (`packages/testkit/src/mocks/bill_com.ts`) is built from BILL's developer docs, and its assumptions list what the first live run must confirm: rate-limit errors as HTTP 400, the filter's time format, and page tokens sent with the first page's filters. The nightly sandbox run signs in at BILL's sandbox and reads a year of records once `SANDBOX_BILL_COM_CLIENT_ID` and `SANDBOX_BILL_COM_CLIENT_SECRET` are set.
