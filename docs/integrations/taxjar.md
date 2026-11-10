### TaxJar

Reads the sales tax on the sales and refunds a store records in TaxJar, and the states and countries it has nexus in. Transactions arrive as the same `tax.transaction_updated` events the Avalara AvaTax connector gives, so finance and compliance read tax from either the same way.

| Setting | What it is |
| --- | --- |
| `TAXJAR_API_TOKEN` | The business's TaxJar API token, from Account > TaxJar API |
| `TAXJAR_ENVIRONMENT` | Optional: `production` (the default) or `sandbox` |
| `TAXJAR_PROVIDERS` | Optional: where transactions were recorded, comma-separated, such as `api,shopify`; `api` when empty |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** TaxJar issues one kind of API token and it can't be limited to reading, so the same token could record, change or delete transactions. The client is what keeps KaratOS to reading: its only requests are five GETs (list and show order transactions, list and show refund transactions, and list nexus regions), to TaxJar's fixed production or sandbox address, with paths and filters built from checked values. Recording a sale or a refund is declared behind the write gate, turned off, and the client has no request to send it.

**What it reads.** TaxJar lists transactions as ids, by the day they were recorded (`from_transaction_date` and `to_transaction_date`), for one source at a time (`provider`, which TaxJar takes as `api` when none is named). So a pass walks each provider's orders and then its refunds through the days in spans of 31, reads each listed transaction (`x-api-version: 2022-01-24`), and ends by reading the nexus regions. The first import covers five years. TaxJar keeps no change time, so each later sync reads the last 31 days again: a transaction recorded late with an earlier day, or changed, is picked up, and an unchanged one is a duplicate. Each 100 transactions read are one batch and one checkpoint, so a resumed pass goes on from the span and place it reached. A transaction deleted between the list and the read is skipped.

**Events.** `tax.transaction_updated` for each sale or refund, with its kind (sale or return), provider, the order a refund refunds, its day, the amount, shipping and sales tax in cents, its exemption (wholesale, government, marketplace or other), the state and country it was shipped from and to, and up to 200 lines by SKU and tax code with their price, discount and tax. Each is keyed by a digest of what was kept. `tax.nexus_updated` lists the nexus regions, keyed the same way, so an unchanged list is a duplicate. A transaction without an id, a day, an amount or a sales tax that reads is dead-lettered.

**Privacy.** A transaction can name the customer, so the ship-to street, city and ZIP code and the line descriptions aren't kept, and the customer id becomes a keyed reference. The ship-from state, city and ZIP code are the store's own and are kept, since sourcing rules tax by them.

**Rate limits.** The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 means the token is wrong or for the other environment, and a 403 that the account can't use the API.

**Testing.** TaxJar gives API tokens to paid accounts only, so the tests run against a mock built from TaxJar's API reference and its official SDKs' documented examples (`packages/testkit/src/mocks/taxjar.ts`). It checks the token, the date format and the provider, and lists what the first client's token must confirm: that both list dates are included, the shape of an error body, and that transactions from a platform integration are listed under that platform's provider name.
