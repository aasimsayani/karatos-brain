# Lightspeed Retail

Research for issue #62 (catalog id `lightspeed`). Checked against Lightspeed's own developer docs on 2026-11-03.

**Step 1 answer: yes.** Lightspeed Retail (X-Series) has a public, versioned API. Any developer can register on the developer portal and build an app that connects to up to 30 stores without Lightspeed's approval, and there is a trial store sign-up. Move this to the next open week.

| Question | What Lightspeed's docs say |
| --- | --- |
| Public API | Yes. The Lightspeed Retail (X-Series) API, versioned by date (for example 2026.01 and 2026.04). |
| Getting access | Register a developer account on the developer portal and create an app. A new app is "Not Approved", which limits it to 30 retailer connections. Lightspeed says that is enough for private apps or testing, and approval is needed only for public apps. |
| Cost | The pages read don't say whether the developer account or trial store is free. |
| Auth | OAuth 2.0 authorization code grant. The code lasts 10 minutes and is single use. Refreshing always returns a new refresh token and revokes the old access token, so the newest refresh token must be stored. Stores on the Plus plan can also create personal tokens, which Lightspeed suggests only for testing. |
| Base URL | `https://<store domain prefix>.retail.lightspeed.app/api/<version>/retailer` |
| Test environment | A trial store, from Lightspeed's trial sign-up page. |
| Covers the issue's scope | The docs have sales, products and inventory guides. Customers weren't covered in the pages read. |
| Rate limits and webhooks | Both are documented, on pages we haven't read yet. |
| Changelog | https://x-series-api.lightspeedhq.com/v2026.01/changelog |

**Which Lightspeed.** Lightspeed runs two retail products. X-Series (formerly Vend) is the one above. R-Series has a separate API that this research doesn't cover. Before building, confirm which one the pilot store runs.

**What this means for the connector.** It follows the same pattern as our other rotating-token OAuth connectors: the newest refresh token is kept sealed in the instance's database.

**Still to confirm.** The rate limits, the customers endpoint, and whether the trial store lasts long enough for the nightly sandbox run.

Sources:
- https://x-series-api.lightspeedhq.com/docs/authorization
- https://x-series-api.lightspeedhq.com/v2026.01/docs
- https://www.lightspeedhq.com/partners/developers/
