### Sola Payments

Reads the card and check payments and refunds that go through a store's Sola Payments gateway (formerly Cardknox), so finance can reconcile them, layaway installments included, against sales and deposits. Payments arrive as the same `payment.charge_updated` and `payment.refund_updated` events the Stripe and Authorize.net connectors give.

| Setting | What it is |
| --- | --- |
| `SOLA_API_KEY` | An API key from the Sola Portal's key management |
| `SOLA_TIME_ZONE` | Optional: the time zone Sola's report times are in, defaulting to `America/New_York` |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** Sola's API keys can run sales and refunds as well as reports, and Sola documents no way to limit one to reports. The client is what keeps KaratOS to reading. It posts only to Sola's reporting address (`x1.cardknox.com/reportjson`), never the gateway that moves money, and only the one command `Report:All`, with dates built from checked values. Creating payment links and recurring schedules for layaways are declared behind the write gate, turned off, and the client has no request to send them. Sola's own error text is never repeated in an error, only its code.

**What it reads.** The transaction report a month at a time, oldest first, 1,000 rows to a page. Past a full page, the next request starts at the last row's time. The first import covers five years. Each later sync covers from two days before the last pass, by day. Each page is one batch and one checkpoint.

**Events.** `payment.charge_updated` for sales, captures, post-auths, authorizations and check sales, and `payment.refund_updated` for refunds and credits. Each has the reference number, amount in cents, currency, status (succeeded, pending for an authorization, or failed for a decline, error or void), Sola's command and result, whether it was voided, card or ACH, the card brand, the batch, and the customer references. Saves, balance checks and gift card commands aren't payments, so they are skipped. Each is keyed by a digest of what was kept, so an unchanged row is a duplicate and a void is a new event. A row without a reference number, a command, a time or an amount that reads is dead-lettered.

**Privacy.** A card is kept as its brand only: no masked number, token, name, address, invoice or description. The customer's email address and phone number only make keyed customer references.

**Rate limits.** Sola doesn't document one. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time.

**Testing.** The tests run against a mock built from Sola's docs (`packages/testkit/src/mocks/sola_payments.ts`). It checks the key, the command, the dates and paging, and lists what the first sandbox run must confirm: the report rows' field names, the time zone of report times, and whether the dates are inclusive. For the nightly run, sign up for a free Sola sandbox account (solapayments.com/devsdk), run a few test-card sales with synthetic customers (`@example.test` addresses), create an API key, and add it as the `SANDBOX_SOLA_PAYMENTS_API_KEY` GitHub Actions secret.
