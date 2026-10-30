### Meta Ads

Reads one ad account's Facebook and Instagram campaign insights by day through Meta's Marketing API (Graph API v26.0). Read-only three ways over: the token holds `ads_read` and nothing else, which the client checks against `/me/permissions` before its first read; its only other request is the insights read for the ad account in the settings, with parameters built from one fixed report; and it never follows a link Meta returns, rebuilding each next page from the cursor instead.

| Setting | What it is |
| --- | --- |
| `META_ADS_ACCESS_TOKEN` | A system user token from the store's Meta Business account, with `ads_read` only and the ad account assigned |
| `META_ADS_ACCOUNT_ID` | The ad account's numeric id, with or without `act_` |

**What it reads.** One report at campaign level, a 31-day window at a time, by day, 500 rows a page: for each campaign, its objective and the account's currency, and the spend, impressions, reach, clicks, purchases and purchase value. The historical import reads two years up to today. Each incremental sync reads again from two weeks before the last day the previous pass read, since Meta keeps attributing purchases to past views and clicks.

**Privacy.** Insights are totals by campaign and day, so nothing names a person. Campaign names are cut short, and one holding an @ is dropped.

**Rate limits.** Meta throttles by app, user and ad account, answering Graph error codes 4, 17, 32, 613, 80000 or 80004 (or HTTP 429). The client sends one request at a time and waits, doubling from a second, three tries, before the error goes to the sync runner, which resumes from its checkpoint next time. Error 190 means the token expired or was revoked; 200 or 10 means the ad account isn't assigned to the system user.

**Writes.** Pausing a campaign and changing its daily budget are declared, so they can be gated and audited, and both are turned off. Each needs a named person's approval and is capped at five a day. Turning them on would also need a token with `ads_management`, which the connector stops on today.

**Events.** `ads.campaign_reported`, the same event Google Ads gives, one per campaign and day, with money in cents and purchases counted from Meta's `purchase` action. Each is keyed by its day, its campaign and a digest of its numbers, so a revised row is stored as a new version and an unchanged one is a duplicate.

**Testing.** The tests run against a mock built from Meta's docs (`packages/testkit/src/mocks/meta_ads.ts`), which checks the token, `ads_read`, the ad account, campaign level by day, the fields, the time range and that a cursor belongs to its read. For the nightly run, create a sandbox ad account from a Meta developer app (Marketing API > Tools), make a system user token for it with `ads_read` only, and add `SANDBOX_META_ADS_ACCESS_TOKEN` and `SANDBOX_META_ADS_ACCOUNT_ID` as GitHub Actions secrets.
