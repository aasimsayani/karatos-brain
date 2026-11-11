### Afterpay

Reads Afterpay's (Cash App Afterpay's) Merchant API v2 on its global hosts: `https://global-api.afterpay.com`, or `global-api-sandbox.afterpay.com` for a sandbox pair. Requests use HTTP Basic auth, with the Merchant ID as the user and the Secret Key as the password, and carry a User-Agent naming KaratOS. The same pair can capture, refund and void orders, and Afterpay doesn't offer credentials limited to reading. So read-only is enforced in the client: it sends one request, a GET of List Payments, with a query string it builds itself, and has no way to send anything else. A refund is declared as a write and stays behind the write gate.

| Setting | What it is |
| --- | --- |
| `AFTERPAY_MERCHANT_ID`, `AFTERPAY_SECRET_KEY` | The merchant's credentials, which Afterpay gives with the merchant account; sandbox and production each have their own pair |
| `AFTERPAY_ENVIRONMENT` | `sandbox` or `production`, with no default, so a setting meant for one can't reach the other |

**What it reads.** List Payments filters by when a payment was created, never by when it last changed. So the historical import reads every payment created in the last five years, oldest first, 250 a page, each with its current state and refunds. Each later sync reads again every payment created in the last 60 days, or since the last sync finished if that was longer ago, and stores only what changed. A refund on an order older than that isn't seen until the next historical import. Each page is a batch, and the checkpoint keeps the window and the offset. Afterpay publishes no rate limit. A 429 or 5xx is retried, honoring `Retry-After` up to a minute or else waiting 1, 2 and 4 seconds, before the sync stops and resumes from its checkpoint. A 401 says the pair is wrong for the environment.

**Events.** These use the same neutral types as Stripe and Affirm:

- `payment.charge_updated` for each Afterpay order: Afterpay's state alongside succeeded, pending or failed, the amount, what was captured and refunded in whole cents, the currency, and the store's own order number (`merchantReference`), so it can be matched to the sale.
- `payment.refund_updated` for each refund, linked to its order.

Each order is keyed by its id, its state and the amounts captured and refunded, so each step is stored once and a replay is a duplicate. A payment's order details carry the shopper's name, email, phone and addresses, plus the items. None of that is kept, nor the checkout token. A row that doesn't read is dead-lettered with what was wrong.

**Testing.** The tests run against a mock built from Afterpay's docs (`packages/testkit/src/mocks/afterpay.ts`). It answers the sandbox or production host only, checks the Basic pair and the User-Agent, refuses parameters the docs don't list, and filters, orders and pages as List Payments describes. Sandbox credentials come from an Afterpay account manager. Once a pair is set up, a nightly sandbox check replaces the mock's assumptions with recordings.
