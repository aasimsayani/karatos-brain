### Zoom

Reads the store's past Zoom meetings and who joined them, so virtual consultations sit beside the appointments booked in Calendly and the visits in the store. Each meeting arrives as an `appointment.held` event.

| Setting | What it is |
| --- | --- |
| `ZOOM_ACCOUNT_ID` | The Account ID of the store's KaratOS Server-to-Server OAuth app |
| `ZOOM_CLIENT_ID` | That app's Client ID |
| `ZOOM_CLIENT_SECRET` | That app's Client Secret |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** A Zoom admin makes the KaratOS app in the Zoom App Marketplace and gives it only two scopes, `report:read:list_history_meetings:admin` and `report:read:list_meeting_participants:admin` (or the older `report:read:admin`). Every token Zoom issues lists its scopes, and the client checks each one: a token with any scope that isn't a read, or that lists none, is not used, and the sync stops saying which scope to take away. The client's only requests are the token request and two GETs to `api.zoom.us`; it ignores the `api_url` a token answer names. Scheduling a meeting is declared behind the write gate, turned off, and the client has no request to send it.

**What it reads.** Zoom's meeting history (`GET /report/history_meetings`) lists the account's past meetings by the day they started, at most a month at a time, and the participant report (`GET /report/meetings/{uuid}/participants`) lists who joined one. A pass reads the history in 30-day spans, 300 to a page, and each meeting's participants; a meeting Zoom has no report for (a 404) is kept with no guests. The first import covers six months, the longest Zoom keeps reports. Each later sync reads from two days before the last one, since a meeting is listed once it ends and by the account's own time zone. Each history page is one batch. Zoom's page tokens last 15 minutes, so the checkpoint keeps the span rather than the token, and a resumed pass reads its span again; what it already read is a duplicate.

**Events.** `appointment.held` for each meeting, with its UUID and meeting id, start and end, length in minutes, kind (bridal, custom design, repair, appraisal, pickup, consultation or other, read from the topic the same way as Calendly titles), Zoom's participant count and how many guests joined (once each, however often they rejoined), when the first guest joined, a keyed host reference, the guests' customer references, and whether the meeting was recorded, shared a screen or had a meeting summary. Each is keyed by the UUID and a digest of what was kept. A meeting without a UUID or times that read is dead-lettered.

**Privacy.** Guests' email addresses only make the same keyed customer references Calendly, custom forms and Klaviyo make, and the host's becomes a keyed host reference, so neither can be read back. Names, devices, IP addresses and locations aren't kept, and the topic only when it carries no participant's or host's name or address. Recordings, chat, transcripts and summaries are never read.

**Rate limits.** Reports are in Zoom's Heavy rate limit group. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 drops the token so the next read asks for a new one, and a 403 means the plan has no reports (they need Pro or higher).

**Testing.** Reports need a paid Zoom plan, so the tests run against a mock built from Zoom's docs (`packages/testkit/src/mocks/zoom.ts`). It checks the app's credentials, the token and its scopes, the day range, paging and how a UUID with a slash is encoded, and lists what the first client's app must confirm: which day a meeting is listed under, and that a rejoining guest is listed once per join.
