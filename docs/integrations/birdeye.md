### Birdeye

Reads one Birdeye business's reviews: the ones Birdeye gathers from Google, Facebook, Yelp and the other sites it watches, and its own direct feedback. They arrive as the same `review.updated` events the Yext connector gives, so marketing and clienteling read reviews from either the same way.

| Setting | What it is |
| --- | --- |
| `BIRDEYE_API_KEY` | The business's Birdeye API key, from the Birdeye dashboard |
| `BIRDEYE_BUSINESS_ID` | The numeric id of the business (location) to read |

**Read-only by design.** Birdeye issues one kind of key and its docs describe no way to limit it to reading, so the same key could reply to reviews. The client is what keeps KaratOS to reading: its only request is Get Reviews (`POST /resources/v1/review/businessId/{id}`, a search sent as a POST) with a body it builds itself. Replying to a review is declared behind the write gate, turned off, and the client has no request to send it.

**What it reads.** The first import reads reviews posted in the last five years (`fromDate`), published and parked alike, 100 a page. Each sync after reads reviews changed since the day the last pass started, less a day (`updateFromDate`), as Birdeye filters by whole days. A page shorter than 100 ends the pass. The checkpoint keeps the offset, so a resumed sync goes on from the page it reached. Birdeye won't page past 100,000 reviews in one read.

**Events.** `review.updated` for each review, with the business, the site it came from, its rating (0 to 5; Birdeye gives 0 for direct feedback and Facebook recommendations), the title and an excerpt, whether it was edited, when it was posted and answered, a link to it, and whether it is still awaiting a reply. Each is keyed by a digest of what was kept, so an edited or newly answered review is stored as a new version and an unchanged one is a duplicate. A review with no readable date is dead-lettered.

**Privacy.** A review is written by a customer, so no reviewer name, nickname, photo or Birdeye customer id is kept, nor the custom fields or the staff named on it. The title and excerpt (the first 500 characters) have email addresses and phone numbers masked. The store's reply is noted, not copied, and a link keeps its address without the query string.

**Rate limits.** Birdeye sets a call limit per key and answers 429 (code 89) past it. The client waits out a 429, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 means the key is wrong, and a 404 that the business id is.

**Testing.** Birdeye has no sandbox. The tests run against a mock built from Birdeye's API docs (`packages/testkit/src/mocks/birdeye.ts`), which checks the key header, the business, the page window and the date format, and lists what the first client's key must confirm: that reviews come oldest first, and that `updateFromDate` includes new reviews.
