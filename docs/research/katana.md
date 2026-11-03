# Katana

Research for issue #214 (catalog id `katana`). Checked against Katana's own developer docs on 2026-11-03.

**Step 1 answer: an API, yes; a free developer account, no.** Katana has a documented public API, but its getting-started guide says an API key needs a Professional plan or higher, and to schedule a demo to get an account. We found no sandbox. Move this to Phase 2 unless a pilot manufacturer already runs Katana Professional.

| Question | What Katana's docs say |
| --- | --- |
| Public API | Yes, `https://api.katanamrp.com/v1/`, with an OpenAPI file at `https://api.katanamrp.com/v1/openapi.json`. |
| Getting access | In Katana, Settings, then API, then API keys, then Add new API key. You must be "on a Professional plan or higher". |
| Auth | `Authorization: Bearer <API key>`. Keys stay on the server. A missing or outdated key answers 401. |
| Rate limits | "By default, Katana API allows 60 requests per 60 seconds." Going over answers 429 with `Retry-After`. The same page's example shows a limit of 30, which contradicts it, so assume 30 until tested. |
| Covers the issue's scope | The reference lists manufacturing orders and sales orders, and the docs cover recipes, materials, stock and purchase orders. |
| Webhooks | Yes, with signature verification. |
| Test environment | None found. Sample data in the docs is tagged "[DEMO]". |

**What this means for the connector.** A bearer key with no expiry makes for a simple connector, and the published OpenAPI file means the mock can be built straight from it. Testing beyond the mock needs a Professional account.

Sources:
- https://developer.katanamrp.com/docs/getting-started
- https://developer.katanamrp.com/reference/api-rate-limiting
- https://developer.katanamrp.com/reference/getallmanufacturingorders
