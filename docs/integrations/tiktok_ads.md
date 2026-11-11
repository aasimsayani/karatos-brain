### TikTok Ads

Reads one advertiser's TikTok campaign report by day through TikTok's API for Business (Marketing API v1.3). Read-only two ways over: the token comes from a developer app made with read scopes only (Ad Account Information and Reporting), and the client's only request is a GET of the report for the advertiser in the settings, with parameters built from one fixed report.

| Setting | What it is |
| --- | --- |
| `TIKTOK_ADS_ACCESS_TOKEN` | A long-lived advertiser token from an app with read scopes only |
| `TIKTOK_ADS_ADVERTISER_ID` | The advertiser's numeric ID |
| `TIKTOK_ADS_ENVIRONMENT` | `production` (the default) or `sandbox` |

**What it reads.** One `BASIC` report at campaign level (`AUCTION_CAMPAIGN`), a 30-day window at a time, by day, 1,000 rows a page: for each campaign, its name and objective, and the spend, impressions, reach, clicks, purchases (`complete_payment`) and purchase value (`total_complete_payment_rate`). The historical import reads two years up to today. Each incremental sync reads again from 28 days before the last day the previous pass read, TikTok's longest attribution window.

**Privacy.** Reports are totals by campaign and day, so nothing names a person. Campaign names are cut short, and one holding an @ is dropped.

**Rate limits and errors.** TikTok answers most errors with HTTP 200 and a code. Rate limits (40016, 40100, 40133, or HTTP 429) and passing faults on TikTok's side (50000, 51001, 51002, 51004, 51041, 51043, 60001, or HTTP 5xx) are retried three times, doubling from a second, before the error goes to the sync runner, which resumes from its checkpoint next time. Codes 40001, 40102, 40104 and 40105 mean the token lacks a scope, expired or was revoked: authorize the app again. TikTok's own message is never shown, only its code.

**Writes.** Pausing and resuming a campaign are declared, so they can be gated and audited, and both are turned off. Each needs a named person's approval and is capped at five a day. Turning them on would also need an app with the Ads Management scope, which isn't requested.

**Events.** `ads.campaign_reported`, the same event Google Ads and Meta Ads give, one per campaign and day, with money in cents of the advertiser's currency. Each is keyed by its day, its campaign and a digest of its numbers, so a revised row is stored as a new version and an unchanged one is a duplicate. A row without a campaign ID or a day that reads is dead-lettered.

**Testing.** The tests run against a mock built from TikTok's docs (`packages/testkit/src/mocks/tiktok_ads.ts`), which checks the token, the advertiser, campaign level by day, the metrics, the 30-day range and paging. For the nightly run, make a sandbox advertiser in the TikTok for Business Developers portal and add `SANDBOX_TIKTOK_ADS_ACCESS_TOKEN` and `SANDBOX_TIKTOK_ADS_ADVERTISER_ID` as GitHub Actions secrets.
