### Trustpilot

Reads the store's Trustpilot page: every service review and the trust score, so marketing sees the store's reputation next to its sales, and every bad review gets an owner. Reviews arrive as the same `review.updated` events the Yext, Birdeye, Yotpo and Judge.me connectors give.

| Setting | What it is |
| --- | --- |
| `TRUSTPILOT_API_KEY` | The API key of a Trustpilot application, never its secret |
| `TRUSTPILOT_BUSINESS_UNIT_ID` | The store's business unit id |

**Read-only by design.** Trustpilot has no read-only scope: an application's key and secret make a business user token that can reply to reviews and send invitations. So KaratOS asks for the key alone. The key reaches only Trustpilot's public endpoints, which show what anyone can see on the store's Trustpilot page, and the client sends only two GETs to `https://api.trustpilot.com/v1`, with the key in the `apikey` header: the business unit, and its reviews, with parameters it builds itself from checked values. Replying to a review and sending an invitation are declared behind the write gate, needing approval, turned off, and the client has no request to send them.

**What it reads.** Trustpilot lists a store's reviews newest first, 100 a page by number, with no filter by date. So each pass reads from the newest and stops at the first page that reaches back past its start. The first import reads five years. Each later sync reads the reviews posted in the last 30 days again, so a reply or an edit in that time is a new event and the rest are duplicates. Each pass reads the trust score with its first page. Each page is one batch, and the checkpoint keeps the pass's start and the next page, so a resumed pass goes on from that page.

**Events.**
- `review.updated` for each review: the rating, a title and excerpt with email addresses and phone numbers masked, the language, whether Trustpilot verified it and whether it counts toward the trust score, likes, whether and when the store replied, and when the customer had the experience, posted it and edited it. A review of two stars or fewer is marked for follow-up, and one without a reply is marked as waiting on one.
- `review.score_updated` for the trust score: the score and stars, the number of reviews, how many count toward the score, and how many there are at each rating. A score that hasn't moved is a duplicate.

Each event is keyed by a digest of what was kept. A review without an id, a rating from 1 to 5 or a time, or a business unit without a trust score or a review count, is dead-lettered.

**Privacy.** Only public reviews are read, never the customer emails and order ids private endpoints carry. Reviewers' display names and locations and the store's reply text are never read into an event; a reviewer is Trustpilot's consumer id.

**Not read.** Product reviews and invitations: their lists need a business user's token, which could also write.

**Rate limits.** Trustpilot asks callers to stay under 833 calls in 5 minutes and 10,000 an hour. The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 500, 502, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 or 403 says the key is wrong or the store lost the API module; a 404 says the business unit id is wrong.

**Testing.** API access needs Trustpilot's API module. The tests run against a mock built from Trustpilot's developer docs (`packages/testkit/src/mocks/trustpilot.ts`). It checks the `apikey` header, the business unit, the parameters the review list takes, the order and the page size. It lists what the first client's key must confirm: that `perPage` goes to 100, that an edit leaves `createdAt` alone, and the key's shape.
