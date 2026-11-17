### Klarna

Reads what Klarna paid a business for its pay-over-time sales, payout by payout, with each sale, return, fee and commission behind it, so finance can match the deposit on the bank statement to the orders. Payouts arrive as `payout.updated` events and their lines as `balance.transaction_recorded` events.

| Setting | What it is |
| --- | --- |
| `KLARNA_API_KEY` | A Klarna API key made for KaratOS: `klarna_live_api_…`, or `klarna_test_api_…` for the playground |
| `KLARNA_USERNAME` | Optional, in place of a key: the API username the Klarna portal shows |
| `KLARNA_PASSWORD` | With `KLARNA_USERNAME`: that credential's key or password |
| `KLARNA_REGION` | Optional: `na` (North America, the default), `eu` or `oc` |
| `KLARNA_ENVIRONMENT` | Optional: `production` (the default) or `playground` |

**Read-only by design.** Klarna doesn't offer a key limited to settlements, so a Klarna key could also capture, refund or cancel orders. The client keeps to the settlement reads: it sends only GET requests, to the payouts list and the settlement transactions list, on the one host the region and environment name. A live key is turned down for the playground and a test key for production. Pages are walked by offset worked out by the client, never by following a link Klarna sends. Capturing and refunding an order are declared behind the write gate, turned off, and the client has no request to send them. Klarna's own error text is never repeated in an error, only the HTTP status. Make a key just for KaratOS, so it can be disabled on its own.

**What it reads.** The first import lists five years of payouts by payout date, 100 to a page, and reads each payout's lines, 500 to a page, before the next payout. Each later sync lists the payouts made since three days before the last pass started, so one Klarna publishes late is still read. Each payout with its lines is one batch and one checkpoint, which keeps the pass's dates and how many payouts it has read.

**Events.** A payout has its payment reference, the amount settled in cents, the currency, the payout date, whether Klarna settles gross or net, and its totals: sales, returns, fees, fee refunds, commission, reversals, holdbacks and releases, charges and credits, repayments, tax, deposits, and the debt balance before and after. A line has its type and Klarna's detailed type, the amount in cents as Klarna signs it, the currency, the Klarna order with its short ID, the capture or refund, the store's own order reference, the VAT, the purchase country, the payment method, and when it was sold and captured. A line has no ID of its own, so each is keyed by its payout, its place in the payout and a digest of what was kept: reading one again unchanged is a duplicate. One without what it needs is dead-lettered.

**Privacy.** Klarna's comment text, the shipping country and the store's second reference are not kept. Klarna's settlement records hold no customer names or contact details.

**Rate limits.** The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time.

**Testing.** The tests run against a mock built from Klarna's docs (`packages/testkit/src/mocks/klarna.ts`). It checks the credential, the date filters and offset paging, and lists what the first playground run must confirm: how the date filters match, the order payouts are listed in, and how an API key is sent. For the nightly run, sign up for a Klarna playground account in North America, make an API key there, and add it as the `SANDBOX_KLARNA_API_KEY` GitHub Actions secret.
