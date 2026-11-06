# NuORDER

Research for issue #196 (catalog id `nuorder`). Checked against NuORDER's own API docs on 2026-11-03.

**Step 1 answer: yes, for a brand on NuORDER.** NuORDER publishes API docs. A brand creates its own API keys in NuORDER under Admin, then API Management, and approves the app there, with no partnership. The docs show a sandbox host, but don't say how to get a sandbox account. Move this to the next open week if the pilot wholesaler is on NuORDER; otherwise, Phase 2.

| Question | What NuORDER's docs say |
| --- | --- |
| Public API | Yes, documented at assets.nuorder.com/api-docs. The examples use `https://nuorder.com`. |
| Getting access | Consumer key and secret from Admin, then API Management. The app then calls `/api/initiate` for temporary credentials. Someone at the brand clicks APPROVE in API Management, which shows a verifier code once, and the app trades it at `/api/token` for a permanent token and token secret. |
| Auth | OAuth 1.0 only, signed with HMAC-SHA1. The signing key is the consumer secret, then `&`, then the token secret. |
| Environments | Examples use `https://sandbox1.nuorder.com`, `staging.nuorder.com` and `next.nuorder.com`, none clearly labeled. |
| Covers the issue's scope | Company (retailers), Buyer, Order, Product, Inventory, Shipment and Invoice are all resources, along with catalogs, payments, price sheets, replenishment and warehouses. |
| Rate limits | Not mentioned. |

**What this means for the connector.** OAuth 1.0 request signing is new for us; none of our connectors does it yet, so the client needs a small, well-tested signer. The token doesn't expire, so there is nothing to renew or store beyond the settings.

**Still to confirm.** How to get a sandbox account, filtering by update date, paging, and rate limits.

Sources:
- https://assets.nuorder.com/api-docs/index.html
