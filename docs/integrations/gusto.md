### Gusto

Reads one company's processed payrolls from Gusto's App Integrations API, asking for API version `2026-06-15` on every request. Read-only is enforced twice. The app holds only the `payrolls:read` scope, and after every token refresh the client calls `GET /v1/token_info` and stops if the token belongs to a company other than `GUSTO_COMPANY_UUID`, holds any scope that doesn't end in `:read`, or doesn't say which scopes it holds. The client also sends GET requests to two payroll endpoints only, and its only POST is the token refresh. It declares no writes: payroll stays with a person in Gusto.

| Setting | What it is |
| --- | --- |
| `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET` | The KaratOS app's keys from the Gusto developer portal |
| `GUSTO_REDIRECT_URI` | The app's registered redirect URI, which Gusto asks for on every refresh |
| `GUSTO_COMPANY_UUID` | The company's UUID, from `GET /v1/token_info` after connecting |
| `GUSTO_REFRESH_TOKEN` | The refresh token from connecting the company. It only seeds the instance's own copy (below) |
| `GUSTO_ENVIRONMENT` | Optional. `demo` for Gusto's demo environment (`api.gusto-demo.com`); production otherwise |
| `GUSTO_WEBHOOK_VERIFICATION_TOKEN` | Optional. The webhook subscription's verification token, for when webhooks are turned on |

**Tokens.** Access tokens last two hours and are refreshed five minutes early, one refresh at a time. Each refresh returns a new refresh token, and Gusto revokes the old one the first time the new access token is used, so the new one is saved before anything else happens. The instance keeps it in its database, sealed the same way as QuickBooks' and Xero's. An `invalid_grant` error means the company needs reconnecting.

**What it reads.** `GET /v1/companies/{company}/payrolls` for processed payrolls with their totals, by check date, oldest first, 100 per page, then `GET /v1/companies/{company}/payrolls/{payroll}` for each one's employee compensations. The historical import reads three years back in windows of at most a year, which is as much as Gusto lists at once. Incremental syncs read again from 45 days before the previous pass, so a payroll processed late or changed after processing is picked up. Both reach 31 days ahead, since Gusto processes a payroll days before its check date. Unprocessed payrolls aren't read, since their numbers can still change. Reversed and cancelled payrolls aren't handled yet.

**Rate limits.** Gusto allows 200 requests a minute per company and app. A 429 is waited out (`Retry-After` when sent, at most a minute, three tries) before the error goes to the sync runner.

**Events.** `payroll.payroll_processed` for each payroll: check date, pay period, regular, off-cycle or external, and gross pay, net pay, employer and employee taxes, benefits, reimbursements, bonuses, commissions and the company debit in whole cents. `payroll.employee_paid` for each employee it paid: gross and net pay, hours, overtime, commissions, bonuses and tips, and the payment method. Employees are named by Gusto's employee UUID only; no names, pay rates, bank details, tax withholdings or deductions are kept. Gusto has no version number on a payroll, so each event is keyed by a hash of what was kept, and a replay is a duplicate. A payroll with no readable check date is dead-lettered rather than given a made-up day.

**Finance.** The finance department turns these into payroll signals, and flags a regular payroll whose gross pay is more than 25% (and at least $500) above the average of the three before it on the same pay schedule, so it gets a second look.

**Webhooks.** `verifyGustoWebhook` checks `X-Gusto-Signature`, the HMAC-SHA256 of the raw body keyed with the verification token. Gusto's docs don't say whether the digest is hex or base64, so both are accepted, compared in constant time; the nightly sandbox run is where that gets confirmed. Gusto retries a delivery for up to three days and signs no timestamp, so `gustoWebhookEvent` returns the event's uuid to drop replays by, and only events for this company. A payroll event is a prompt to sync, not data. The instance doesn't take webhooks yet; the scheduled sync picks every change up.

**Testing.** The tests run against a mock built from Gusto's docs (`packages/testkit/src/mocks/gusto.ts`), which replaces refresh tokens and revokes the old one on first use of the new access token, answers `token_info`, needs the API version header and enforces the one-year window and paging. For the nightly run, create a Gusto developer account, make a demo company with a few synthetic employees and processed payrolls, connect it to a test app with only `payrolls:read`, and add `SANDBOX_GUSTO_CLIENT_ID`, `SANDBOX_GUSTO_CLIENT_SECRET`, `SANDBOX_GUSTO_REDIRECT_URI`, `SANDBOX_GUSTO_COMPANY_UUID` and `SANDBOX_GUSTO_REFRESH_TOKEN` as GitHub Actions secrets. The nightly run can't save the replacement refresh token, so expect `invalid_grant` after its first use until the run can store tokens.
