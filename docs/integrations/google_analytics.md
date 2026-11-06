### Google Analytics 4

Reads one GA4 property's reports through the Google Analytics Data API (v1beta). Read-only three ways over: the connection holds `analytics.readonly` and nothing else, which the client checks on every new access token; the only API request it sends is `runReport` for the property in the settings, with a body built from two fixed reports; and the Admin API is never called. Analytics has nothing to write, so no write is declared.

| Setting | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The instance's Google OAuth client, shared with Gmail and Google Workspace. Turn on the Google Analytics Data API in its Cloud project |
| `GOOGLE_ANALYTICS_REFRESH_TOKEN` | A refresh token from a Google account with Viewer access to the property, granted `analytics.readonly` only |
| `GOOGLE_ANALYTICS_PROPERTY_ID` | The property's numeric id from Admin > Property details (not the `G-` measurement id) |

**What it reads.** Two reports, a 31-day window at a time, 10,000 rows a page, sorted on every dimension so paging is stable:

- Traffic: by day, default channel group and source / medium, the sessions, total users, new users, engaged sessions, key events (GA4's conversions), ecommerce purchases and total revenue.
- Products: by day and item, the items viewed, added to cart and purchased, and item revenue.

The historical import reads two years up to today. Each incremental sync reads again from three days before the last day the previous pass read, since GA4 keeps adding late hits to recent days.

**Privacy.** Reports are totals by day, so nothing names a visitor. Source, medium and item names are cut short, and one holding an @ is dropped in case a campaign tag carried an email address. When GA4 withholds small rows (thresholding), the events say so.

**Rate limits.** The Data API meters each property in tokens per hour and per day. The client sends one request at a time and waits out a 429 (`Retry-After` when sent, otherwise doubling from a second, three tries) before the error goes to the sync runner, which resumes from its checkpoint next time. A 403 means the connected account can't read the property.

**Events.** `analytics.traffic_reported` and `analytics.product_views_reported`, one per row, with the day, the property's currency and time zone, and money in cents. Each is keyed by its day, its dimensions and a digest of its numbers, so a revised row is stored as a new version and an unchanged one is a duplicate.

**Testing.** The tests run against a mock built from Google's docs (`packages/testkit/src/mocks/google_analytics.ts`), which checks the token's scopes, the property, the date range, that item-scoped and session-scoped fields aren't mixed, and pages and sorts. For the nightly run, give a test Google account Viewer access to Google's public GA4 demo account (the Google Merchandise Store), connect it to a test OAuth client with `analytics.readonly`, and add `SANDBOX_GOOGLE_ANALYTICS_CLIENT_ID`, `SANDBOX_GOOGLE_ANALYTICS_CLIENT_SECRET`, `SANDBOX_GOOGLE_ANALYTICS_REFRESH_TOKEN` and `SANDBOX_GOOGLE_ANALYTICS_PROPERTY_ID` as GitHub Actions secrets.
