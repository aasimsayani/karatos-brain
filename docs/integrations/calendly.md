### Calendly

Reads Calendly's API v2 (`https://api.calendly.com`) with a personal access token: the signed-in user, the organization's scheduled events and each event's invitees. Each invitee of an event is one appointment.

| Setting | What it is |
| --- | --- |
| `CALENDLY_ACCESS_TOKEN` | A personal access token with only the `users:read` and `scheduled_events:read` scopes, made by an owner or admin so it can read every team member's appointments |
| `CUSTOMER_REF_KEY` | Generated. Keys the customer references (below); the same key custom forms and Klaviyo use |

**Read-only.** The client sends only three GETs: `/users/me`, `/scheduled_events` and `/scheduled_events/{uuid}/invitees`, with parameters it builds itself. Event ids and page tokens are checked before they go into a request, and the next page is asked for by its `page_token`, never by following the `next_page` link, so a reply can't send the token to another host. Calendly has no way to ask which scopes a token holds, so give it the two read scopes only. Booking, cancelling and marking a no-show are declared behind the write gate, and the test shows each one is stopped.

**What it reads.** The first import reads every event starting from two years ago to a year ahead, earliest first, 100 a page. Each batch's checkpoint records the start time it read up to, so a resumed import carries on just before it. Calendly lists events by start time, not by when they changed, so each later sync reads events from 30 days ago to a year ahead, the span where bookings are moved, cancelled and marked no-shows. An event's invitees are read again only when the event changed since the last sync (the checkpoint keeps a short hash of each recent event) or it started in the last 14 days, when no-shows are marked. That keeps a free plan's 50 requests a minute enough for a busy store. When the token's owner isn't an owner or admin, Calendly answers 403 to the organization's events and the connector reads the owner's own instead. A 429 is waited out for `X-RateLimit-Reset` seconds, up to a minute, three times, then left to `runSync`, which retries from the checkpoint. A 401 or a 403 naming missing scopes stops the sync with a message saying what to fix.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `appointment.booked` | An active invitee | invitee and a digest of what was read |
| `appointment.canceled` | A cancelled invitee, with when and whether the host or invitee cancelled | invitee and digest |
| `appointment.no_show` | An invitee marked a no-show | invitee and digest |

Each one carries the appointment's kind (bridal, custom design, repair, appraisal, pickup, consultation or other, read from the event's title), its start, end and length, the kind of place (in person, phone, video, custom or ask the invitee), the hosts as `calendly:user:<id>`, how many guests and answered questions, when it was booked and whether staff booked it, links to the booking it replaced or was replaced by when rescheduled, a payment's provider, amount in cents and currency, and the UTM source, medium and campaign it came from. A booking read again unchanged is a duplicate. An invitee or event whose id, times or status don't read is dead-lettered listing what was wrong.

**Privacy.** Names, email addresses, phone numbers, guests' addresses, answers to the booking questions, meeting notes, cancellation reasons, cancel and reschedule links and where the meeting is held are never kept. The invitee's email address and text reminder number are used only to make customer references, made exactly the way custom forms makes them, so a booking, a form submission and a Klaviyo profile from the same address name the same customer. The event title is kept only when it doesn't hold any word of the invitee's name or email address, since one-off meetings are often named after the person.

**Webhooks.** None. Calendly's webhook subscriptions need a paid plan and the `webhooks:write` scope, which a read-only token shouldn't hold, so the scheduled sync polls.

**Testing.** The tests run against a mock built from Calendly's API reference (`packages/testkit/src/mocks/calendly.ts`). It answers 401 for the wrong token, 403 when a member who isn't an admin lists the organization, filters and sorts by start time, pages with `page_token`, and can answer 429 with the rate limit headers. Its assumptions are listed in the mock and checked on the first sandbox run. For the nightly run, create a free Calendly account for testing only, book a few appointments with synthetic invitees (`@example.test` addresses), make a personal access token with the two read scopes, and add it as the `SANDBOX_CALENDLY_ACCESS_TOKEN` GitHub Actions secret.
