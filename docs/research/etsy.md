# Etsy

Research for issue #94 (catalog id `etsy`). Checked against Etsy's own developer docs on 2026-11-03.

**Step 1 answer: yes.** Etsy has a public API (Open API v3), and a seller can register a seller app for their own shop in the Developer Portal without a partnership. Etsy says eligible sellers are approved within minutes. Move this to the next open week.

| Question | What Etsy's docs say |
| --- | --- |
| Public API | Yes, Open API v3. |
| Getting access | Register an app in the Developer Portal. A **seller app** is limited to the seller's own shop, and Etsy says eligible sellers are approved within minutes; it can't be used commercially. A **personal app** gets a deeper review, and **commercial access** (any seller who grants OAuth consent) needs an approved personal app plus a manual review. |
| Cost | No fee is mentioned on the pages read. |
| Auth | OAuth 2.0 authorization code grant, with PKCE required on every flow. Every request also carries an `x-api-key` header holding the app's keystring and shared secret. Access tokens last one hour; refresh tokens last 90 days. |
| Read scopes for the issue's scope | `transactions_r` (sales and purchases), `listings_r` (inactive and expired listings) and `shops_r` (shop details). |
| Rate limits | Per API key, by queries per second and per day, shown in the Developer Portal. The docs' example is 150 a second and 100,000 a day. A 429 comes with `retry-after`. |
| Test environment | No sandbox is described. Etsy publishes an API testing policy, which we haven't read yet. A real seller shop is needed. |
| Webhooks | Etsy documents webhooks. |
| Changelog | No changelog page found. The docs point feedback to the Etsy open-api GitHub discussions. |

**What this means for the connector.** Orders (receipts and transactions), listings and inventory fit the three read scopes above. A seller app covers a single store connecting its own shop, which is our pilot case. Offering it to many stores would need commercial access.

**Still to confirm.** The receipts endpoint's filters and page size, which buyer fields it returns, and what the API testing policy allows.

Sources:
- https://developers.etsy.com/documentation/
- https://developers.etsy.com/documentation/essentials/authentication/
- https://developers.etsy.com/documentation/essentials/rate-limits/
- https://developers.etsy.com/documentation/essentials/webhooks/
