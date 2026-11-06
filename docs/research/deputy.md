# Deputy

Research for issue #219 (catalog id `deputy`). Checked against Deputy's own developer docs on 2026-11-03.

**Step 1 answer: yes.** Deputy has a public REST API. A customer can build their own integration by creating an OAuth token for their own profile, and Deputy also offers a permanent token. Rosters, timesheets, employees, locations and leave are all API resources, and most endpoints have webhooks. Only the Embed product and the Advanced Employee API (which exposes tax file numbers) need an agreement or a security check, and neither is in the issue's scope. Move this to the next open week.

| Question | What Deputy's docs say |
| --- | --- |
| Public API | Yes, RESTful JSON. |
| Getting access | Customers "creating an OAuth token for their profile", or a permanent token. Public apps use OAuth. Embed needs a signed commercial agreement, and the Advanced Employee API an extra vendor security check. |
| Covers the issue's scope | Roster, Timesheet, Employee, Leave and Location (Company) resources. |
| Webhooks | Available for most endpoints, on insert, update, delete and modify, and can be filtered. |
| Test environment | Not stated on the pages read. |

**What this means for the connector.** The ordinary Employee resource should be enough. The connector should stay off the Advanced Employee API, since the issue doesn't need tax numbers.

**Still to confirm.** The base URL for an install, the auth header, token lifetimes, rate limits, and whether a free trial install works for the nightly sandbox run. Deputy's "Using OAuth 2.0" guide and its docs index (developer.deputy.com/llms.txt) are the next pages to read.

Sources:
- https://developer.deputy.com/docs/public-api-facts-and-overview
- https://developer.deputy.com/docs/authenticating-with-deputy
- https://developer.deputy.com/docs/timesheet
