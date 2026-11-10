### Judge.me

Reads a shop's Judge.me reviews, each on the product and customer it is about, with reviews of two stars or fewer marked for follow-up. Reviews arrive as the same `review.updated` events the Yext, Birdeye and Yotpo connectors give.

| Setting | What it is |
| --- | --- |
| `JUDGEME_SHOP_DOMAIN` | The shop's domain, such as `example.myshopify.com` |
| `JUDGEME_API_TOKEN` | An OAuth token with only `read_reviews`, or the private API token |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** Judge.me's private API token reads and writes alike: it could post reviews and change what is published. An OAuth token can be limited to `read_reviews`, and that is the one to use when the shop can grant it. Either way the client is what keeps KaratOS to reading: its only request is a GET of the review list (`api.judge.me/api/v1/reviews`), to Judge.me's fixed address, with a query built from checked values. Replying to a review and publishing or hiding one are declared behind the write gate, turned off, and the client has no request to send them. Judge.me takes the token in the query string, so no error the client raises carries a URL.

**What it reads.** Every page of the shop's reviews, 100 to a page by page number, since Judge.me has no filter by date. The first import keeps the reviews posted or changed in the last five years. Each later sync keeps the ones changed since two days before the last pass started. Each page is one batch and one checkpoint.

**Events.** `review.updated` for each review, with its id, whether it is about a product (and the product's id on the store platform) or the store, the rating, whether it needs follow-up, the title and an excerpt with email addresses and phone numbers masked, where it came from, its curation and verification status, whether it is published or hidden, how many photos show, the reviewer's Judge.me reference and customer references, and when it was posted and last changed. Each is keyed by a digest of what was kept, so an unchanged review is a duplicate. A review without an id, a rating or a time that reads is dead-lettered.

**Privacy.** Reviewers' email addresses and phone numbers only make keyed customer references. Names, IP addresses, marketing tags and photo links aren't kept.

**Rate limits.** Judge.me doesn't document one. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time.

**Testing.** Judge.me has no sandbox, so the tests run against a mock built from Judge.me's docs (`packages/testkit/src/mocks/judgeme.ts`). It checks the shop domain, the token and paging, and lists what the first client's shop must confirm: the order reviews come back in, whether hidden and unpublished reviews are listed, and the time zone of Judge.me's times.
