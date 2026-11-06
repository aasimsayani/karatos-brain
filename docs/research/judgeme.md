# Judge.me

Research for issue #186 (catalog id `judgeme`). Checked against Judge.me's own help center on 2026-11-03.

**Step 1 answer: yes, with a store's own token.** Judge.me has a documented REST API. A store finds its private API token in the Judge.me admin under Settings, then Integrations, then View API tokens, so no partnership is needed. There is no separate developer sandbox, so testing needs a store with Judge.me installed. Move this to the next open week once a test store is set up.

| Question | What Judge.me's docs say |
| --- | --- |
| Public API | Yes, `https://judge.me/api/v1`. The reviews example uses `https://api.judge.me/api/v1/reviews`. |
| Getting access | The private token in the Judge.me admin. Judge.me also documents OAuth for integration partners. |
| Cost | The pages read don't say which plan includes the API. The Awesome plan is $15 a month. Ask Judge.me support whether the free plan has API access. |
| Auth | Each request carries `shop_domain` (the myshopify.com domain) and `api_token`. The private token gives read and write access, so it must stay on the server. The public token is only for the widget API. |
| Reviews endpoint | `GET /reviews`, up to 100 a page with `page`. It can filter by product, rating, published state and reviewer. |
| Platforms | The examples are Shopify-first. Creating a review accepts `shopify`, `woocommerce` or `bigcommerce` as the platform. |
| Rate limits, webhooks, changelog | Not stated on the pages read. |

**What this means for the connector.** Our side can stay read-only by sending only GETs, but the token itself can't be limited to reading. A store using the connector should know that. Reviewer emails come back from the API, so the connector should keep them out, as our Yext connector does.

**Still to confirm.** API access on the free plan, the rate limits, and whether the API can filter by update date for incremental syncs.

Sources:
- https://judge.me/help/en/articles/8409180-using-judge-me-api
- https://judge.me/help/en/articles/8283047-setting-up-oauth
- https://judge.me/help/en/articles/8415450-judge-me-awesome-plan
