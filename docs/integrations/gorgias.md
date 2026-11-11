### Gorgias

Reads the store's Gorgias helpdesk: every ticket from email, chat and social, and every message on it, so clienteling, sales and repairs see what online customers asked about and how fast the store answered.

| Setting | What it is |
| --- | --- |
| `GORGIAS_DOMAIN` | The helpdesk's subdomain: `store` for store.gorgias.com |
| `GORGIAS_CLIENT_ID` | The client id of the KaratOS app in Gorgias's partner portal |
| `GORGIAS_CLIENT_SECRET` | That app's client secret |
| `GORGIAS_REFRESH_TOKEN` | The refresh token from the store connecting the app to its helpdesk |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** Gorgias API keys carry the full permissions of the user who made them, and the read-only Observer role can't make one, so KaratOS doesn't use a key. It uses an app that asks only for `openid`, `offline` and `tickets:read`. Each sign-in's token lists the app's scopes, and the client stops before reading anything if one of them isn't a read scope, or if the token doesn't say. It sends only three requests to the store's own `https://{domain}.gorgias.com`: the refresh-token sign-in, List tickets and List messages, with parameters it builds itself from checked values and Gorgias's page cursor, never from a link in an answer. Adding an internal note and tagging a ticket are declared behind the write gate, each needing approval, turned off, and the client has no request to send them.

**What it reads.** Gorgias lists tickets by when they last changed, newest first, 100 a page, with a cursor and no time filter. So a pass reads tickets newest first and stops at the first one that last changed before its floor, reading each ticket's messages (oldest first) as it goes. The first import's floor is five years back. Each later sync's floor is the newest change the last pass saw, less five minutes: a new message or a status change moves its ticket to the front, so only changed tickets are read. An unchanged ticket or message is a duplicate. The first later sync looks back two days. Each page of tickets is one batch, and the checkpoint keeps the floor, the newest change seen and Gorgias's cursor, so a resumed pass goes on from the page it reached.

**Events.**
- `communication.ticket_updated` for each ticket: status, channel and how it came in, tags (the store's own labels, lowercased, up to 20), the assigned agent (Gorgias's user id), whether the store started it, spam, trashed or unread, the satisfaction score, and when it was created, opened, last received a message, last had a message, was closed, is snoozed until and last changed.
- `communication.message_logged` for each message: the channel, the ticket as its conversation, inbound, outbound or an internal note, the agent who wrote it, how long its text was, how many attachments, whether a rule sent it, whether it failed or was deleted, and when it was sent and opened.

Each event is keyed by a digest of what was kept. A ticket without an id, a creation time or a status, or a message without an id, a ticket, a time or who wrote it, is dead-lettered.

**Privacy.** Message text, HTML, subjects, attachments, customer names and notes are never read into an event. Customers' emails become the same customer references custom forms, Klaviyo, Quo and AvaTax make (an HMAC under `CUSTOMER_REF_KEY`), so one person lines up across systems without the address being kept. Staff are Gorgias's user ids.

**Rate limits.** Apps get 80 requests in 20 seconds. The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. It signs in again once on a 401. A 403 says the app lacks `tickets:read`; a 404 says the subdomain is wrong.

**Testing.** Gorgias apps are made in its partner portal. The tests run against a mock built from Gorgias's developer docs (`packages/testkit/src/mocks/gorgias.ts`). It checks the Basic auth and the refresh grant, the bearer token, the parameters each list takes, the sort and the page size. It lists what the first client's connection must confirm: how the refresh grant authenticates, that the scope is space-separated, that a new message moves its ticket's `updated_datetime`, that times are UTC, and the satisfaction score's shape.
