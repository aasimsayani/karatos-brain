### Google Ads

Reads one Google Ads account's campaign figures by day through the Google Ads API (REST, v26). Google Ads has one OAuth scope, `adwords`, and it can change campaigns, so the scope can't keep the connection read-only. The client does: its only API request is `googleAds:search` for the account in the settings, with a query built from one fixed report, and it never calls a mutate method. Connect it as a Google Ads user with Read only access, so Google would turn down a change even if one were sent.

| Setting | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The instance's Google OAuth client, shared with the other Google connectors. Turn on the Google Ads API in its Cloud project |
| `GOOGLE_ADS_REFRESH_TOKEN` | A refresh token from a Google account with Read only access to the Google Ads account, granted `adwords` only |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | From a manager account's API Center. A new token reads test accounts only; a store's real account needs Basic access |
| `GOOGLE_ADS_CUSTOMER_ID` | The account's 10-digit customer id, with or without dashes |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Optional. The manager account's customer id, when the user reaches the store's account through one |

**What it reads.** One report, a 31-day window at a time, in Google's fixed pages of 10,000 rows: for each campaign and day, its status, channel and daily budget, and the impressions, clicks, cost, conversions and conversion value. The historical import reads two years up to today. Each incremental sync reads again from two weeks before the last day the previous pass read, since Google keeps attributing conversions to past clicks.

**Privacy.** The report is totals by campaign and day, so nothing names a person. Campaign names are cut short, and one holding an @ is dropped.

**Rate limits.** Google Ads meters each developer token in operations per day. The client sends one request at a time and waits out a 429 (`Retry-After` when sent, otherwise doubling from a second, three tries) before the error goes to the sync runner, which resumes from its checkpoint next time. A 403 means the connected user can't reach the account, or needs `GOOGLE_ADS_LOGIN_CUSTOMER_ID`; `DEVELOPER_TOKEN_NOT_APPROVED` means the token has test access only.

**Writes.** Pausing a campaign and changing its daily budget are declared, so they can be gated and audited, and both are turned off. Each needs a named person's approval and is capped at five a day. Turning them on would also need a user with Standard access in Google Ads.

**Events.** `ads.campaign_reported`, one per campaign and day, with the account's currency and time zone, and money in cents (Google gives cost and budget in micros). Each is keyed by its day, its campaign and a digest of its numbers, so a revised row is stored as a new version and an unchanged one is a duplicate.

**Testing.** The tests run against a mock built from Google's docs (`packages/testkit/src/mocks/google_ads.ts`), which checks the access token, the developer token, the scope, the account and manager headers, the GAQL fields, and that a page token belongs to its query, and counts any mutate call. For the nightly run, create a Google Ads test manager account with a test client account under it, connect a test Google account to a test OAuth client with `adwords`, and add `SANDBOX_GOOGLE_ADS_CLIENT_ID`, `SANDBOX_GOOGLE_ADS_CLIENT_SECRET`, `SANDBOX_GOOGLE_ADS_REFRESH_TOKEN`, `SANDBOX_GOOGLE_ADS_DEVELOPER_TOKEN`, `SANDBOX_GOOGLE_ADS_CUSTOMER_ID` and `SANDBOX_GOOGLE_ADS_LOGIN_CUSTOMER_ID` as GitHub Actions secrets. Any developer token reads test accounts.
