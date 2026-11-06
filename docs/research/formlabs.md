# Formlabs 3D printing

Research for issue #97 (catalog id `formlabs`). Checked against Formlabs' own Web API docs on 2026-11-03.

**Step 1 answer: yes.** Formlabs has a public Web API. Any Formlabs.com account with at least one connected printer can create API credentials in the Formlabs Dashboard, with no partnership. It reads printers, prints (with date, material, printer and status filters), tanks, cartridges and events. That covers the issue's scope, print jobs and their status. Move this to the next open week. Testing beyond a mock needs a connected printer.

| Question | What Formlabs' docs say |
| --- | --- |
| Public API | Yes, `https://api.formlabs.com/developer/v1/`. Formlabs also has a Local API that runs on the store's own network, and PreForm developer tools. |
| Getting access | Create application credentials (a client id and secret) on the Developer Tools page of dashboard.formlabs.com. It needs a Formlabs.com account with at least one connected printer. Cost isn't stated. |
| Auth | OAuth 2.0 client credentials: a form POST with `grant_type=client_credentials`, the client id and the secret. A token lasts a day (86,400 seconds) and goes in `Authorization: bearer <token>`. The docs' sample response shows `grant_type=client_secret`, which contradicts the required value. |
| What it reads | Printers (with live status), prints for the account or for one printer, tanks, cartridges, account events, and printer groups with their queues. |
| Rate limits | 100 requests a second per IP address, and 1,500 an hour per user. Going over answers 429 with `Retry-after`. |
| Test environment | None. It needs a real account with a connected printer. |

**What this means for the connector.** Client credentials need no stored refresh token. The 1,500 an hour limit is plenty for a store's print history. The printer group endpoints can also create, update and delete, so the connector should send only GETs.

Sources:
- https://support.formlabs.com/s/article/Formlabs-Web-API (redirects to https://formlabs-dashboard-api-resources.s3.amazonaws.com/formlabs-web-api-latest.html)
- https://support.formlabs.com/s/article/Formlabs-Local-API
- https://formlabs.com/support/What-is-the-Formlabs-Developer-Platform/
