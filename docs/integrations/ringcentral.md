### RingCentral

Reads every call, text and voicemail on the store's RingCentral line (one extension). They arrive as the same `communication.call_logged` and `communication.message_logged` events Quo's and Twilio's give, so clienteling, repairs and sales see who called or wrote, and how fast the store answered, whichever phone system it uses.

| Setting | What it is |
| --- | --- |
| `RINGCENTRAL_CLIENT_ID` | The client id of the store's private KaratOS app, made for the JWT auth flow |
| `RINGCENTRAL_CLIENT_SECRET` | That app's client secret |
| `RINGCENTRAL_JWT` | A JWT credential made by the user whose extension is the store's line, allowed for that app only |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** The app is given only Read Call Log and Read Messages. Each sign-in's token says which permissions the app has, and the client stops before reading anything if one of them isn't a read permission (ReadCallLog, ReadMessages, ReadAccounts, ReadContacts or ReadPresence) or if the token doesn't say. It sends only three requests to `https://platform.ringcentral.com`: the JWT sign-in, the extension's call log and its message store, with parameters it builds itself from checked values and a page number, never from a link in an answer. Sending a text and placing a RingOut call are declared behind the write gate, turned off, and the client has no request to send them.

**What it reads.** A JWT signs in as one user, and the extension call log and message store are scoped to that user, so KaratOS reads only the store line's extension. RingCentral's sync APIs can't return more than 250 call records at a time, so they can't import history. So a pass lists the calls and then the texts and voicemail in a span, 250 a page. The first import covers two years. Each later sync starts where the last pass started, less a day, because a call ends after it starts and a text is read or a voicemail deleted after it arrives. An unchanged one is a duplicate. The first later sync looks back two days. Each page is one batch, and the checkpoint keeps the span, the step and the page, so a resumed pass goes on from the page it reached. The connector polls, so it needs no public route for webhooks.

**Events.**
- `communication.call_logged` for each call: voice or fax, inbound or outbound, RingCentral's action and result, whether an inbound call was missed (Missed, Voicemail, Rejected, Busy, No Answer, Hang Up, Abandoned or Declined), whether the caller withheld their number, duration, and when it started.
- `communication.message_logged` for each text or voicemail: the channel (`sms` or `voicemail`), the conversation, direction, status, whether it was read or deleted, how long a text was, how long a voicemail ran and whether it was transcribed, and when it arrived and last changed.

Each event is keyed by a digest of what was kept. A call or message without an id, a time, a direction or a result (for a call) or a text or voicemail type (for a message) is dead-lettered.

**Privacy.** Calls, texts and voicemail are the customer's own words, so no text, subject, voicemail audio, transcript or recording is read into an event, and caller names and locations are dropped. Customers' numbers become the same customer references Quo, custom forms, Klaviyo and AvaTax make (an HMAC under `CUSTOMER_REF_KEY`), so one person lines up across systems without the number being kept. Withheld callers and short codes get no reference.

**Rate limits.** The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 503 or 504, before the error goes to the sync runner, which resumes from its checkpoint next time. It signs in again once on a 401. A 403 names the permission the app is missing.

**Testing.** RingCentral's developer sandbox needs an account. The tests run against a mock built from RingCentral's developer guide (`packages/testkit/src/mocks/ringcentral.ts`). It checks the Basic auth and the JWT grant, the bearer token, the parameters each list takes and the page size. It lists what the first client's credential must confirm: that the token's scope is space-separated, that the call log pages like the message store, which results mean a missed call, and that changes land within a day.
