# RepairShopr

Research for issue #256 (catalog id `repairshopr`). Checked against RepairShopr's own site on 2026-11-03.

**Step 1 answer: yes, for a RepairShopr account.** RepairShopr has a REST API. The docs are linked from the API section of each account's Admin Center, and requests are made with the account's subdomain and an API key. RepairShopr has since added per-application API tokens with access limited to what each app needs. We found no free developer account, so this needs the store's own RepairShopr account. Move this to the next open week if the pilot store uses RepairShopr; otherwise, Phase 2.

| Question | What RepairShopr's site says |
| --- | --- |
| Public API | Yes. The docs open from the account's Admin Center (API, then Documentation). |
| Getting access | An API key for the account. Newer tokens are made "on an individual application basis" and limit access to the data a given app needs. |
| Auth | The account's subdomain and API key. A newer authentication method arrived with the new tokens; the post announcing it doesn't describe it. |
| Plans, rate limits, expiry | Not stated on the pages read. |
| Test environment | None found. |

**What this means for the connector.** If a token can be limited to reading tickets, customers and invoices, the connector should check that its token is limited to those, as our scoped connectors do.

**Still to confirm.** Read the API docs inside a RepairShopr account for the auth header, the permission choices, paging and limits.

Sources:
- https://www.repairshopr.com/blog/posts/feature-friday-api-documentation
- https://www.repairshopr.com/blog/posts/feature-release-api-updates-new-token-system-with-granular-permissions-and-a-new-authentication-method
