### Zendesk

Reads the store's Zendesk helpdesk: every ticket and every customer who opened one, so clienteling, sales and repairs see what customers asked about and how fast the store answered.

| Setting | What it is |
| --- | --- |
| `ZENDESK_SUBDOMAIN` | The helpdesk's subdomain: `store` for store.zendesk.com |
| `ZENDESK_CLIENT_ID` | The unique identifier of the OAuth client an admin made for KaratOS |
| `ZENDESK_CLIENT_SECRET` | That client's secret |
| `ZENDESK_REFRESH_TOKEN` | The refresh token from an admin authorizing the client for `tickets:read` and `users:read` |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** KaratOS doesn't use a Zendesk API token, which carries its admin's full permissions. An admin authorizes an OAuth client for only `tickets:read` and `users:read`, and every refresh asks for those two scopes again, which can only narrow the token. If the token answer lists a scope that isn't a read scope, the client stops before reading anything. It sends only three requests to the store's own `https://{subdomain}.zendesk.com`: the refresh-token sign-in and the cursor-based ticket and user exports, with parameters it builds itself from checked values and Zendesk's cursor, never from a link in an answer. Adding an internal note and tagging a ticket are declared behind the write gate, each needing approval, turned off, and the client has no request to send them.

**Rotating refresh tokens.** Zendesk's refresh tokens are single-use: each refresh returns a new one and retires the old. The newest is saved, encrypted under a key derived from the client secret, in the instance's database before it is used, as QuickBooks's is; `ZENDESK_REFRESH_TOKEN` is the seed, and replacing it there wins over the stored one. Each refresh asks for a 90-day refresh token, Zendesk's longest, so a sync at least that often keeps the connection alive.

**What it reads.** Zendesk's incremental exports list every record that changed since a time, oldest change first, up to 1,000 a page, and end with a cursor that picks up from there next time. The first import starts the ticket and user exports five years back and reads each to its end, tickets first. Each later sync goes on from the cursors the last one ended with, so it reads only what changed; with no checkpoint it starts two days back. An unchanged record read again is a duplicate. Each page is one batch, and the checkpoint keeps both cursors.

**Events.**
- `communication.ticket_updated` for each ticket, as Gorgias's are: status, type, priority, the channel it came in by, tags (lowercased, up to 20), the requester, submitter and assignee (Zendesk user ids), its organization, group and brand, the satisfaction rating (offered, unoffered, good or bad), whether it is public, and when it was created, is due and last changed.
- `customer.profile_updated` for each end user, never staff: `zendesk_user:{id}` as the customer, the customer references of their email and phone, their organization and tags, and whether they are verified, suspended or deleted. Zendesk doesn't record marketing consent, so none is claimed.

Each event is keyed by a digest of what was kept. A ticket without an id, a creation time or a status, or a user without an id or a creation time, is dead-lettered.

**Privacy.** Subjects, descriptions, comments, names, notes, details and custom fields are never read into an event. Emails and phone numbers become the same customer references custom forms, Klaviyo, Quo and Gorgias make (an HMAC under `CUSTOMER_REF_KEY`), so one person lines up across systems without the address being kept. A ticket's requester and the customer's profile share the Zendesk user id.

**Rate limits.** The ticket export allows 10 requests a minute, and the user export 20. The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. It signs in again once on a 401. A 403 says the token can't read the exports, which need an admin's authorization; a 404 says the subdomain is wrong.

**Testing.** Zendesk trials are vendor accounts. The tests run against a mock built from Zendesk's developer docs (`packages/testkit/src/mocks/zendesk.ts`). It checks the JSON refresh grant, that each refresh retires the last tokens, the bearer token, the parameters each export takes and its order. It lists what the first client's connection must confirm: that a token with `tickets:read` and `users:read` can read the exports, that a narrowed refresh keeps only those scopes, the scope's shape, how a finished export's cursor picks up later changes, the time format and the satisfaction scores.
