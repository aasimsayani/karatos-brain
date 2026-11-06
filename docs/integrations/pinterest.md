### Pinterest

Reads one Pinterest business account's Pins and analytics through Pinterest's API (v5). Read-only two ways over: the connection holds `boards:read`, `pins:read` and `user_accounts:read` and nothing else, which the client checks on every token refresh before reading anything; and its only requests are the Pin list and two analytics reads for the connected account, with parameters it builds and checks itself.

| Setting | What it is |
| --- | --- |
| `PINTEREST_CLIENT_ID` | The App id of a Pinterest developer app the store owns |
| `PINTEREST_CLIENT_SECRET` | The same app's App secret key |
| `PINTEREST_REFRESH_TOKEN` | The business account's refresh token, with the three read scopes only |

**What it reads.** Every pass reads every Pin the account owns, 250 a page, with its title, the page it links to, its board and its 90-day and lifetime metrics. Then the account's daily impressions, saves, Pin clicks, outbound clicks and engagements: 90 days on the first import, which is as far back as Pinterest's analytics reach, and the last 30 days on each sync after, since Pinterest keeps refining recent days. Last, the 50 Pins saved most over the last 30 days, ranked.

**Events.** `social.pin_updated` for each Pin, `social.account_reported` for each day and `social.top_pin_reported` for each ranked Pin. Each is keyed by a digest of its numbers, so a revised day or Pin is stored as a new version and an unchanged one is a duplicate.

**Privacy.** Pins are the store's own posts and analytics are totals, so nothing names a customer. A Pin's description isn't kept, a title holding an @ is dropped, and a link keeps its address without the query string or fragment.

**Tokens.** Pinterest replaces the refresh token on every refresh (continuous refresh tokens, 60 days each). The newest is kept in the instance's database, sealed with a key derived from the client secret, so a daily sync keeps the connection alive indefinitely.

**Rate limits.** The client sends one request at a time and waits out a 429 (honoring `Retry-After` up to a minute, doubling from a second otherwise), three tries, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 renews the access token once. A 403 on analytics means the account isn't a business account.

**Writes.** Creating a Pin for a product, with its photo and a link to its page, is declared so it can be gated and audited, and is turned off. It needs a named person's approval. Turning it on would also need a token with `pins:write` and `boards:write`, which the connector stops on today.

**Testing.** The tests run against a mock built from Pinterest's OpenAPI description (`packages/testkit/src/mocks/pinterest.ts`), which checks the client credentials, the refresh token rotation, each token's scopes, the 90-day analytics window, page sizes, metrics and that a bookmark belongs to its list. Pinterest's sandbox doesn't serve analytics, so for the nightly run connect a test business account to a developer app with the three read scopes and add `SANDBOX_PINTEREST_CLIENT_ID`, `SANDBOX_PINTEREST_CLIENT_SECRET` and `SANDBOX_PINTEREST_REFRESH_TOKEN` as GitHub Actions secrets.
