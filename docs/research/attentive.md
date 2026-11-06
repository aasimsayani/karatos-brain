# Attentive

Research for issue #70 (catalog id `attentive`). Checked against Attentive's own developer docs on 2026-11-03.

**Step 1 answer: an API, yes, but mostly for sending data in, not reading it out.** An Attentive customer can create a custom app and get an API key with no partnership. The custom app's permissions are set per API and are either "No Access" or "Write", though, and the six APIs on offer (Custom Attributes, Custom Events, eCommerce, Privacy Request, Product Catalog and Subscribers) have no reporting or campaign-metrics permission. Neither of the issue's two read needs is covered by the documented scopes: reading subscribers, or reading campaign metrics. Move this to Phase 2 and ask Attentive whether a reporting export or a read API exists.

| Question | What Attentive's docs say |
| --- | --- |
| Public API | Yes, at docs.attentive.com, with an OpenAPI reference. |
| Getting access | On the integrations setup page, choose Create App. The API key is shown once ("This is the only time you will be able to copy this API key") and can be regenerated later. A `/me` endpoint checks the key works. |
| Permissions | Per API: No Access (the default) or Write. No read-only setting is listed. |
| Covers the issue's scope | Subscribers: there are calls to subscribe a user and to check one user's subscription eligibility, but no subscriber list was found. Campaign metrics: no reporting API was found. |
| Test environment | Not mentioned. |

**What this means for the connector.** A read-only connector can't be built from the documented API alone. If Attentive offers scheduled report exports, a file connector would be the way in.

Sources:
- https://docs.attentive.com/docs/create-and-manage-custom-apps
- https://docs.attentive.com/docs/authentication
- https://docs.attentive.com/reference/addsubscriptions
- https://docs.attentive.com/reference/getsubscriptions
