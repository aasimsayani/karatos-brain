### Deputy

Reads a business's Deputy schedules and worked hours, with their cost, by location and area, so labor can be set against sales and bench output by day. Locations, areas, team members, shifts, timesheets and leave each arrive as a `labor.*` event.

| Setting | What it is |
| --- | --- |
| `DEPUTY_ACCESS_TOKEN` | A Deputy permanent token made for KaratOS |
| `DEPUTY_INSTALL` | The install's host, like `example.na.deputy.com` |

**Read-only by design.** A Deputy token acts as the person who made it, with their access level, and Deputy has no read-only level or token scope. The client keeps to the reads: it sends only the Resource API search (`POST /api/v1/resource/<Object>/QUERY`, which Deputy uses for reads too) for the six records the connector uses, to the one install the settings name. Make the token as someone who can see costs (a Location Manager or System Administrator), on a Client ID named for KaratOS so it can be removed on its own. Publishing a schedule and approving a timesheet are declared behind the write gate, turned off, and the client has no request to send them. Deputy's own error text is never repeated in an error, only the HTTP status.

**What it reads.** A pass reads locations (`Company`), areas (`OperationalUnit`), team members (`Employee`), shifts (`Roster`), timesheets and leave, one after another, in Id order, 500 to a page. The first import reads every location, area and team member, three years of shifts and timesheets by date, and the leave that ends in that time. Each later sync reads each of those records Deputy says changed (`Modified`) since an hour before the last pass started. Each page is one batch and one checkpoint, which keeps the record type and how many of it the pass has read.

**Events.** A shift has its team member, area, day, start and end, hours, cost, whether it's published or open, the team member's confirmation and the timesheet it matched. A timesheet has its team member, area, shift, day, start and end, hours, cost, whether its time and pay are approved, whether it's in progress, discarded, exported or paid, the leave it's for, and whether Deputy flagged it. Leave has its team member, location, leave rule, first and last day, days, hours and status. A location has its name, code and parent; an area its name, location, parent and payroll code; a team member their location, start and end dates, access level and whether they're active. Each is keyed by a digest of what was kept, so an unchanged record is a duplicate and an approval is a new event. One without an ID or a time that reads is dead-lettered.

**Privacy.** A team member is kept as their Deputy ID, never their name, birthday, address, contact details, photo or pronouns. Comments on shifts, timesheets and leave, and shift warnings, are not kept.

**Rate limits.** The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time.

**Testing.** The tests run against a mock built from Deputy's docs (`packages/testkit/src/mocks/deputy.ts`). It checks the token, the search, sort and paging, and lists what the first trial run must confirm: how a search compares days and times, that `ge` is inclusive, and that `start` pages a stable order.
