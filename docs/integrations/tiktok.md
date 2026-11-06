### TikTok

Reads the store's own TikTok account through TikTok's Display API (v2). Read-only two ways over: the connection holds `user.info.basic`, `user.info.stats` and `video.list` and nothing else, which the client checks on every token refresh before reading anything; and its only requests are the profile read and the video list, with fields and a page cursor it builds and checks itself.

| Setting | What it is |
| --- | --- |
| `TIKTOK_CLIENT_KEY` | The client key of a TikTok for Developers app the store owns |
| `TIKTOK_CLIENT_SECRET` | The same app's client secret |
| `TIKTOK_REFRESH_TOKEN` | The store account's refresh token, with the three read scopes only |

**What it reads.** Each pass reads the account's followers, accounts followed, total likes and video count, then its public videos, newest first, 20 a page: on the first import every video posted in the last two years, and on each sync after, the videos of the last 90 days again, since their views and likes are still moving. Each video comes with its title, its share link, how long it runs and its views, likes, comments and shares.

**Events.** `social.account_reported` for the account's counts on the day read and `social.video_updated` for each video. Each is keyed by a digest of its numbers, so a video whose counts moved is stored as a new version and an unchanged one is a duplicate.

**Privacy.** Videos are the store's own posts and the counts are totals, so nothing names a customer. A video's description isn't asked for, a title holding an @ is dropped, and a link keeps only a tiktok.com address without its query string.

**Tokens.** Access tokens last a day. TikTok may answer a new refresh token on a refresh, and the newest is kept in the instance's database, sealed with a key derived from the client secret. A refresh token lasts a year from when the account signed in, so the account signs in again once a year.

**Rate limits.** The client sends one request at a time and waits out a 429 (honoring `Retry-After` up to a minute if TikTok sends one, doubling from a second otherwise), three tries, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 renews the access token once, except when TikTok says a scope was never allowed. An error code other than `ok` in an answer is treated as an error, whatever the HTTP status.

**Writes.** Posting a product video is declared so it can be gated and audited, and is turned off. It needs a named person's approval. Turning it on would also need a token with `video.publish`, which the connector stops on today.

**Testing.** The tests run against a mock built from TikTok for Developers' Display API docs (`packages/testkit/src/mocks/tiktok.ts`), which checks the client credentials in the form, the refresh token rotation, each token's scopes and the scope each field needs, page sizes and time cursors. For the nightly run, add a sandbox to the developer app with a test TikTok account, sign it in with the three read scopes, and add `SANDBOX_TIKTOK_CLIENT_KEY`, `SANDBOX_TIKTOK_CLIENT_SECRET` and `SANDBOX_TIKTOK_REFRESH_TOKEN` as GitHub Actions secrets.
