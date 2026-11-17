### Acuity Scheduling

Reads one Acuity Scheduling account through the Acuity API v1, at `https://acuityscheduling.com/api/v1` ([developer docs](https://developers.acuityscheduling.com)): its appointments, scheduled and canceled, with its appointment types read only for their names. They arrive as the same events the Calendly connector gives, so an appointment reads alike whichever system booked it. API access needs the Premium or Powerhouse plan ([help article](https://help.acuityscheduling.com/hc/en-us/articles/16676949253389-Using-custom-CSS-and-APIs)).

| Setting | What it is |
| --- | --- |
| `ACUITY_USER_ID` | The account's numeric user id, from Integrations > API > View credentials |
| `ACUITY_API_KEY` | The account's API key, shown beside the user id |
| `CUSTOMER_REF_KEY` | Generated. Keys the customer references (below); the same key custom forms, Calendly and Klaviyo use |

**Sign-in and read-only.** Requests use HTTP Basic auth with the numeric user id as the username and the API key as the password, and a User-Agent naming KaratOS ([quick start](https://developers.acuityscheduling.com/reference/quick-start.md)). The key reaches the whole account: Acuity has no read-only key, and its OAuth has only the one `api-v1` scope ([OAuth2](https://developers.acuityscheduling.com/docs/oauth2)). So read-only is enforced in code: the client sends GET requests to two lists, `/appointments` and `/appointment-types`, with query strings it builds itself, and has no way to send anything else. Both settings are checked before anything is sent: the user id must be digits, and the key 16 to 128 visible characters. A 401 or 403 stops the sync with a message naming both settings and where to find them.

**What it reads.** `GET /appointments` has no paging: no offset, page or cursor, only `max` and a `minDate`/`maxDate` window, and the docs give `max` a default of 100 and no upper bound ([get appointments](https://developers.acuityscheduling.com/reference/get-appointments)). So the connector walks the calendar in windows of at most a month, oldest first, and asks for each window twice: `canceled=false` for scheduled appointments and `canceled=true` for canceled ones, each with `max=100`, `direction=ASC` and `excludeForms=true`, so intake forms are never even sent. A window that comes back with 100 of either list may have more, so it is split in half and each half read again, down to a single day. A single day that still fills a request is read as far as it goes, and a marker saying which day and list were cut short is dead-lettered, so nothing goes missing silently. The historical import reads from two years ago to 90 days ahead and stops for good once done. Each later sync reads from 60 days back to 90 days ahead, since appointments are moved, paid, cancelled and marked no-shows after they are made, and booked ahead; what didn't change comes back as duplicates. A change to an appointment older than 60 days isn't seen. Each pass first reads `GET /appointment-types?includeDeleted=true` ([appointment types](https://developers.acuityscheduling.com/reference/appointment-types)) for their names. Each window is one batch, and the checkpoint holds the windows still to read, the next one first, so a sync that stops resumes at the window it was on. Acuity allows 10 requests a second and 20 connections at once ([errors](https://developers.acuityscheduling.com/docs/api-errors)); a 429 (or a 500, 502, 503 or 504) is retried three times, honoring `Retry-After` up to a minute or else waiting 1, 2 and 4 seconds, before the sync stops and resumes from its checkpoint.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `appointment.booked` | A scheduled appointment | appointment id and a digest of what is kept |
| `appointment.canceled` | A canceled appointment | appointment id and digest |
| `appointment.no_show` | An appointment marked a no-show (`noShow`) | appointment id and digest |

Each one carries the appointment's id, its type's id and name, its kind (bridal, custom design, repair, appraisal, pickup, consultation or other, read from the type's name as Calendly does), whether it was canceled, its start, end and length in minutes, the calendar as `acuity:calendar:<id>` only (a calendar is often named after a staff member, and no staff names are kept), the day it was booked, and its price and amount paid in whole cents with whether it is paid. The time of the event is the appointment's start, since Acuity gives only the day an appointment was booked and no time it was cancelled. An appointment read again unchanged is a duplicate. One whose id, start time or duration doesn't read is dead-lettered listing what was wrong, never guessed.

**Privacy.** Names, email addresses, phone numbers, calendar names, notes, intake form answers, labels, the location, certificate codes and the confirmation link are never kept. The client's email address and phone number are used only to make customer references, made exactly the way custom forms and Calendly make them, so a booking, a form submission and a Klaviyo profile from the same address name the same customer. The type's name is kept only when it doesn't hold any word of the client's name or email address, the check Calendly makes of an event's title.

**Writes.** Cancelling an appointment is declared behind the write gate, needing approval each time and at most five a day, and turned down while writes are off. The client has no way to send it.

**Webhooks.** None yet; the scheduled sync polls.

**Testing.** Acuity has no sandbox, and API access needs a paid plan. The mock (`packages/testkit/src/mocks/acuity.ts`) is built from Acuity's API reference, and its assumptions list what the first live run on an account must confirm, among them the `minDate`/`maxDate` format (the docs type them only as dates) and that `max=100` is safe.
