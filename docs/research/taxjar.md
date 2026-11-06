# TaxJar

Research for issue #85 (catalog id `taxjar`). Checked against TaxJar's own docs on 2026-11-03.

**Step 1 answer: an API, yes; a free sandbox, no.** TaxJar has a public Sales Tax API that any TaxJar account can reach with its API token. Its sandbox, though, is reserved for TaxJar Professional customers. Without one, the connector would be tested against a mock and then the store's own account. Move this to Phase 2 unless the pilot store is on Professional.

| Question | What TaxJar's docs say |
| --- | --- |
| Public API | Yes, the Sales Tax API, with a reference that covers transactions (orders and refunds) and nexus regions. |
| Getting access | An API token from the store's TaxJar account. |
| Test environment | "At this time the Sandbox environment is reserved for TaxJar Professional customers." Others have to ask support. TaxJar keeps a separate list of which endpoints the sandbox supports. |
| Covers the issue's scope | Tax transactions and nexus are both in the API reference. |

**What this means for the connector.** Reading transactions and nexus regions is a small connector. The open question is only how to test it without a Professional account.

**Still to confirm.** The auth header, rate limits and paging, read from the API reference before building.

Sources:
- https://support.taxjar.com/article/162-is-there-a-sandbox-environment-for-api-testing
- https://support.taxjar.com/article/677-which-sandbox-endpoints-are-currently-supported
- https://developers.taxjar.com/api/reference/
