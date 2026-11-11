### Ramp

Reads a business's Ramp company card transactions, so finance sees each purchase with its spend category, GL account, receipt and approval state at month-end. Each arrives as a `card.transaction_updated` event.

| Setting | What it is |
| --- | --- |
| `RAMP_CLIENT_ID` | The client ID of a Ramp developer app made for KaratOS |
| `RAMP_CLIENT_SECRET` | That app's client secret |
| `RAMP_ENVIRONMENT` | Optional: `production` (the default) or `sandbox` |

**Read-only by design.** The app signs in with OAuth client credentials and asks for one scope, `transactions:read`. If Ramp grants the token any other scope, the connector doesn't use it. The client sends only GET requests to the transactions list, and follows Ramp's next-page links only while they point back at that list on the same host, so the token goes nowhere else. Adding a memo and coding a transaction are declared behind the write gate, turned off, and the app is never given a write scope. Ramp's own error text is never repeated in an error, only the HTTP status.

**What it reads.** The first import lists five years of transactions by when they were made, oldest first, 100 to a page. Each later sync lists the transactions Ramp says changed (`updated_after`) since a day before the last pass started, so a receipt, memo, category or settlement added since is read again. Each page is one batch and one checkpoint, which keeps Ramp's link to the next page. Tokens last ten days and are renewed before they run out, or at once if Ramp stops taking one.

**Events.** Each transaction has its ID, the amount in cents with whether money went out or came back, the currency, the amount the merchant charged when it was another currency, Ramp's state, the merchant's name and category code, Ramp's spend category, the GL account it's coded to, the cardholder's Ramp user ID with their department and location, whether it has a receipt and a memo, its policy violations, whether it's disputed, whether all its requirements are met and approved, the transaction a refund is for, and when it was made and settled. Each is keyed by a digest of what was kept, so an unchanged transaction is a duplicate and a new receipt is a new event. One without an ID, a time or an amount that reads is dead-lettered.

**Privacy.** A cardholder is kept as their Ramp user ID, never their name. A memo or receipt is kept as whether there is one, never its text or file.

**Rate limits.** Ramp allows 200 requests in 10 seconds. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time.

**Testing.** The tests run against a mock built from Ramp's docs (`packages/testkit/src/mocks/ramp.ts`). It checks the client credentials, the scope, the filters and paging, and lists what the first sandbox run must confirm: how the date filters match, and how `start` pages. For the nightly run, ask Ramp for a sandbox, make an app there with the client credentials grant and `transactions:read` only, and add its ID and secret as the `SANDBOX_RAMP_CLIENT_ID` and `SANDBOX_RAMP_CLIENT_SECRET` GitHub Actions secrets.
