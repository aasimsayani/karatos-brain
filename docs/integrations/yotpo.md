### Yotpo

Reads a store's Yotpo reviews and, when Loyalty is set up, its members' points and tiers, so staff can thank fans and look after unhappy buyers. Reviews arrive as the same `review.updated` events the Yext and Birdeye connectors give.

| Setting | What it is |
| --- | --- |
| `YOTPO_STORE_ID` | The store ID (app key), from Reviews > Settings > General Settings |
| `YOTPO_API_SECRET` | The store's API secret, from the same page |
| `YOTPO_LOYALTY_GUID` | Optional: the Loyalty program's GUID, from Loyalty > Settings |
| `YOTPO_LOYALTY_API_KEY` | Optional, with the GUID: the Loyalty API key |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** Yotpo gives a store one API secret and one Loyalty API key, and neither can be limited to reading: the secret could moderate and reply to reviews, and the Loyalty key could adjust points. The client is what keeps KaratOS to reading: its only requests are the access token request and two GETs, Retrieve all reviews (`api.yotpo.com/v1/apps/{store}/reviews`) and Fetch recently updated customers (`loyalty.yotpo.com/api/v2/customers/recent`), to Yotpo's fixed addresses, with filters built from checked values. Replying to a review and adjusting points are declared behind the write gate, turned off, and the client has no request to send them.

**What it reads.** Reviews updated since a day (`since_updated_at`), unpublished ones included so a hidden review shows as unpublished, 100 to a page by page number. The first import covers five years. Each later sync reads from two days before the last pass started, since Yotpo's data lags an hour. Then, with Loyalty set up, the members Yotpo updated in the last seven days, 500 to a page by cursor; Loyalty has no older list, so a member's balance arrives the next time it changes. Each page is one batch and one checkpoint.

**Events.** `review.updated` for each review, with its id, whether it is about a product (and the sku) or the store, the rating, title and excerpt with email addresses and phone numbers masked, Yotpo's sentiment score, whether the reviewer was a verified buyer or incentivized (and how), helpful votes, whether it is published or escalated, the reviewer's customer reference, and when it was posted and last changed. `loyalty.customer_updated` for each member, with their points balance, points earned, when points expire, perks redeemed, VIP tier and its dates, total spend in cents and purchases, last purchase and visit, whether they opted in and have a store account, and their customer references. Each is keyed by a digest of what was kept, so an unchanged review or balance is a duplicate. A review without an id, a rating or a time that reads, or a member without an id, is dead-lettered.

**Privacy.** Reviewers' and members' email addresses and phone numbers only make keyed customer references. Names, birthdays, anniversaries, the store platform's customer id and referral links aren't kept.

**Rate limits.** Yotpo allows 5 requests a second per store. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 on reviews drops the token so the next read asks for a new one.

**Testing.** Yotpo has no sandbox, so the tests run against a mock built from Yotpo's docs (`packages/testkit/src/mocks/yotpo.ts`). It checks the store ID, secret, token, Loyalty GUID and key, the filters and paging, and lists what the first client's store must confirm: the order reviews come back in, that a page past the last is empty, and the day `since_updated_at` is read in.
