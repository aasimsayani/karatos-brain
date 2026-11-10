### Quo (formerly OpenPhone)

Reads every call and text on a store's Quo lines. They arrive as the same `communication.call_logged` and `communication.message_logged` events the Twilio connector gives, so clienteling, repairs and sales see who called or wrote, and how fast the store answered, whichever phone system it uses.

| Setting | What it is |
| --- | --- |
| `QUO_API_KEY` | An API key from the Quo workspace's Workspace Settings > API |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** Quo issues one kind of API key and "each key has full access to your workspace's API", so the same key could send texts, change contacts or add webhooks. The client is what keeps KaratOS to reading. It sends only two requests, List calls (`GET /calls`) and List messages (`GET /messages`), to `https://api.quo.com`, with `Quo-Api-Version: 2026-03-30` and filters it builds itself from checked values. Sending a text and adding a contact note are declared behind the write gate, turned off, and the client has no request to send them.

**What it reads.** Quo lists calls and messages newest first by when they were created, 50 a page, with a cursor and no change-time filter. So a pass reads the calls and then the messages created in a span. The first import covers two years. Each later sync starts where the last pass started, less a day, because a call or text changes after it is created: it is answered, ends or is delivered. An unchanged one is a duplicate. The first later sync looks back two days. Each page is one batch, and the checkpoint keeps the span and Quo's cursor, so a resumed pass goes on from the page it reached. Quo can send webhooks, but the connector polls so it needs no public route.

**Events.**
- `communication.call_logged` for each call: the store's line (Quo's phone number id), inbound or outbound, status, whether an inbound call was missed (busy, not answered, cancelled, missed or abandoned), who answered (Quo's user id), duration, whether it was forwarded or handled by Quo's AI agent, and when it started, was answered and ended.
- `communication.message_logged` for each text: SMS or MMS, the conversation, line, direction, status, who sent it, how many attachments, how long the text was, and when it was sent and last changed.

Each event is keyed by a digest of what was kept. A call or text without an id, a time, a direction or a status Quo documents is dead-lettered.

**Privacy.** Calls and texts are the customer's own words, so no message text, media link, call summary, voicemail, recording or transcript is read into an event. Customers' numbers become the same customer references custom forms, Klaviyo and AvaTax make (an HMAC under `CUSTOMER_REF_KEY`), so one person lines up across systems without the number being kept. Withheld callers and short codes get no reference. Contacts aren't read: Quo's contact list carries names but no numbers, so it adds nothing a reference could link.

**Rate limits.** Quo allows 10 requests a second per key and answers 429 past it, without a `Retry-After` header. The client backs off (1, 2 and 4 seconds) on a 429, 500, 502, 503 or 504, honoring a `Retry-After` up to a minute if one comes, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 means the key is wrong or deleted. A 403 means the workspace can't use the API.

**Testing.** Quo has no sandbox. The tests run against a mock built from Quo's API reference (`packages/testkit/src/mocks/openphone.ts`). It checks the version header, the raw key, the filters each list takes and the page size. It lists what the first client's key must confirm: that a cursor stays good while the data it pages through changes, that a call or text's changes land within a day, and whether a 429 carries `Retry-After`.
