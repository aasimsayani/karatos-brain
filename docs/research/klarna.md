# Klarna

Research for issue #216 (catalog id `klarna`). Checked against Klarna's own docs on 2026-11-03.

**Step 1 answer: yes.** Klarna has public REST APIs with a separate playground (test) environment. Klarna's checklist describes creating a test account by signing up through its partner portal. Settlement data, including payouts, their transactions and the CSV and PDF reports, is available through a Settlements API. Move this to the next open week.

| Question | What Klarna's docs say |
| --- | --- |
| Public API | Yes. Order management and settlements are both documented REST APIs. |
| Getting access | Create a test account by signing up through the partner portal, then generate test and live API credentials in the merchant portal. |
| Cost | The pages read don't say whether a test account is free. |
| Auth | HTTP Basic, with the API key in the header (`Authorization: Basic <API key>`). Clients that need a username can send the credential's UUID as the username and the key as the password. |
| Base URLs | Live: `https://api.klarna.com/` (Europe), `https://api-na.klarna.com/` (North America), `https://api-oc.klarna.com/` (Oceania). Playground: `https://api.playground.klarna.com/`, `https://api-na.playground.klarna.com/` and `https://api-oc.playground.klarna.com/`. |
| Settlements | Klarna's suggested daily flow: list payouts for their totals and payment references, fetch each payout's transactions, and optionally download the CSV report by payment reference. PDF summaries come per payout or for a date range. Reports can also arrive over SFTP. |
| Covers the issue's scope | Orders, captures and refunds through order management, and settlements and payout reports through the Settlements API. |

**What this means for the connector.** Reading payouts and their transactions gives fees, refunds and settlements next to the store's other payment sources. Capturing or refunding an order would be a declared write behind the write gate.

**Still to confirm.** The Settlements API paths and paging, whether the playground returns settlement data at all, and how far back order management reads (the issue asks for five years).

Sources:
- https://docs.klarna.com/acquirer/klarna/get-started/integration-checklist/
- https://docs.klarna.com/api/authentication/
- https://docs.klarna.com/acquirer/klarna/get-started/integration-resilience/api-urls/
- https://docs.klarna.com/payments/after-payments/settlements/settlement-reporting-getting-started/
