### Yext

Reads the store's Yext account through Yext's Management API (v2): its locations and the reviews Yext gathers from Google, Yelp, Facebook and the other publishers it watches. Read-only by request: its only requests are two GETs, the location list and the review list, with parameters it builds and checks itself. Yext API keys carry no scopes the connector could check, so give the app the key belongs to read access to Entities and Reviews and nothing else.

| Setting | What it is |
| --- | --- |
| `YEXT_API_KEY` | An API key of a Yext app the store owns, with read access to Entities and Reviews |
| `YEXT_ACCOUNT_ID` | The account to read; unset reads the key's own account |
| `YEXT_ENVIRONMENT` | `production` (default) or `sandbox` |

**What it reads.** Each pass reads every location, 50 a page, with its name, address, time zone and whether it is closed. Then the reviews Yext last updated in a range of days, 100 a page: the last two years on the first import, and on each sync after, the days since the last pass ended, starting two days early so a review updated late on a day already read is read again.

**Events.** `location.updated` for each location and `review.updated` for each review, with its location, publisher, rating, an excerpt, its status, when it was published and last updated, a link to it, how many comments it has, how many are the store's replies, and whether it is still awaiting one. Each is keyed by a digest of what was kept, so an edited or newly answered review is stored as a new version and an unchanged one is a duplicate.

**Privacy.** A review is written by a customer, so it keeps no author name or email, and its title and excerpt (the first 500 characters) have email addresses and phone numbers masked. Replies are counted, not copied. A link keeps its address without the query string.

**Rate limits.** Yext allows 5,000 Management API requests an hour. The client sends one request at a time and waits out a 429, a 500 or a 504, doubling from a second, three tries, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 means the key is wrong, and a 403 that the app lacks read access.

**Writes.** Replying to a review and changing a location's hours are declared so they can be gated and audited, and are turned off. Each needs a named person's approval, and the client has no request to send either.

**Testing.** The tests run against a mock built from Yext's Management API docs (`packages/testkit/src/mocks/yext.ts`), which checks the API key header, the version date, the account, the app's access, page sizes, update-date ranges and that a page token belongs to its query. For the nightly run, add an app in a Yext sandbox account with read access to Entities and Reviews and add its key as the GitHub Actions secret `SANDBOX_YEXT_API_KEY`.
