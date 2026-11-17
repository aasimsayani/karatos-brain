### Google Business Profile

Reads a store's Google Business Profile: its locations, their Google reviews and their daily views, calls, direction requests and website clicks, so marketing and clienteling see Google next to Yext, Trustpilot and the store's own reviews.

| Setting | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The instance's Google OAuth client, shared with the other Google connectors |
| `GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN` | The refresh token of a connection with `business.manage` only |
| `GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID` | The account's numeric id, the digits after `accounts/` |

**Read-only by design.** Google offers only one scope for these APIs, `business.manage`, which can also change a profile. So the connection holds `business.manage` and nothing else, which the client checks on every new access token, and the client sends only GETs to three fixed paths under the one account in the settings, with query strings it builds itself: the location list (Business Information v1, asking only for each location's name, title and store code), each location's reviews (My Business v4) and each location's daily metrics (Business Profile Performance v1). Its only other request is the token refresh. Replying to a review is declared behind the write gate, needing approval, turned off, and the client has no request to send it. Google approves Business Profile API access per project on request; a project without it is turned down with a 403.

**What it reads.** Each sync reads the account's locations first, then each location's reviews newest change first, down to where the sync starts, then its daily metrics a month-long window at a time. The first import reads two years back. Each later sync reads reviews changed since the newest change the last one saw, less a day, and metrics again from a week before the last day read, since Google keeps filling in recent days; the first later sync looks back three days for reviews and ten for metrics. A row read again unchanged is a duplicate.

**Events.**
- `location.updated` for each location: its name and store code.
- `review.updated` for each review, in the shape the Yext and Trustpilot connectors give: the rating, an excerpt with emails and phone numbers masked, whether it was left anonymously, whether and when the store replied and the reply's state, and when it was written and edited. Two stars or fewer is marked for follow-up.
- `analytics.local_listing_reported` for each location and day: Maps and Search views on desktop and mobile, direction requests, calls, website clicks, messages and bookings. Google leaves a zero out, so a metric it doesn't give is zero.

**Privacy.** The reviewer's name and photo are never kept, nor the text of the store's reply. Locations' addresses, phones and hours aren't asked for.

**Rate limits.** A 429, 500, 502, 503 or 504 is waited out as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, before the error goes to the sync runner, which resumes from its checkpoint. A token turned down mid-sync is replaced once.

**Testing.** The tests run against a mock built from Google's developer docs (`packages/testkit/src/mocks/google_business_profile.ts`). It checks the token, the account, page sizes and tokens, the review order, the metric names and the date range. The first live run must confirm that a location's name is `locations/` and its id, how far back the Performance API answers, and that page tokens last the length of a sync.
