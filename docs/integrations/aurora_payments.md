### Aurora Payments

Reads a business's card and ACH settlement batches from Aurora Payments, which renamed itself Flute in 2026, with each transaction in them, so a deposit on the bank statement can be matched to the sales, refunds and fees behind it. Batches arrive as `payout.updated` and their transactions as `balance.transaction_recorded`.

| Setting | What it is |
| --- | --- |
| `AURORA_CLIENT_ID` | The client ID of a Flute API key made for KaratOS |
| `AURORA_CLIENT_SECRET` | That key's client secret |
| `AURORA_ENVIRONMENT` | Optional: `production` (the default) or `sandbox` |

**Read-only by design.** Flute signs a request in with a token that lasts about 15 minutes, made from the API key with the client credentials grant. A merchant's own key can reach every endpoint, writes included; only a key made under a partner whose permissions allow just the reads is limited. Where the business is under a partner, ask for a key allowed only List Transactions, Get Transaction Details and Get Settlement Batches. Either way, the client keeps to the reads: it sends one POST, for a token, to Flute's OAuth server (`oauth.api.flute.com`, or `sandbox.oauth.api.flute.com`), and otherwise only GET requests to the settlement batches and transactions lists. Refunding and voiding a transaction are declared behind the write gate, turned off, and the client has no request to send them. Flute's own error text is never repeated in an error, only the HTTP status.

**What it reads.** The first import lists five years of settlement batches by when they were batched (`dateFrom`, `dateTo`), oldest first, 50 to a page, and reads each batch's transactions (`batchId`) before the next batch. Each later sync lists the batches from a week before the last pass started, so a batch that was open then is read again once it settles. Each settlement batch, with its transactions, is one batch and one checkpoint, which keeps the pass's dates and how many batches it has read. A list's `total` says when it ends; without one, a short page does.

**Events.** A batch has the processor's batch number, the processor, whether it is open or settled, its transaction count, and its sales, refunds and net in cents. A transaction has its batch, type (sale, refund, void and the rest), status, payment method (card or ACH), where it came from (a terminal, an invoice, the API), its currency, and its base, total, surcharge, tax, tip and discount amounts in cents. Each is keyed by a digest of what was kept, so an unchanged record is a duplicate and a batch that settles is a new event. One without an ID or a time that reads is dead-lettered; a batch dead-lettered for its time still has its transactions read.

**Privacy.** No customer name, company, email, phone or masked card number is kept, nor the merchant's own name for a payment method or terminal.

**Rate limits.** Flute documents a 429 but no numbers. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time. A token turned down mid-pass is replaced once.

**Testing.** The tests run against a mock built from Flute's docs (`packages/testkit/src/mocks/aurora_payments.ts`), and a nightly run against Flute's sandbox checks the real API once `SANDBOX_AURORA_PAYMENTS_CLIENT_ID` and `SANDBOX_AURORA_PAYMENTS_CLIENT_SECRET` are set. The mock lists what the sandbox run must confirm: that `dateFrom` and `dateTo` match `batchDateTime` inclusively, that the lists sort oldest first by those fields, and that `batchId` on the transactions list matches a card batch as well as an ACH one.
