### HRD Antwerp report check

Looks up the HRD Antwerp reports behind the report numbers the business holds, through HRD's public MyHRD API, and checks each night that they are still valid. It confirms what each stone or jewel is before it is sold, insured or bought, and flags a number HRD has no report for.

| Setting | What it is |
| --- | --- |
| `HRD_API_TOKEN` | A MyHRD API token, requested through API Access in MyHRD |
| `HRD_REPORT_NUMBERS_FILE` | A text or CSV file of report numbers, one per line in the first column. Blank lines and lines starting with `#` are skipped; a line holding anything else stops the sync, naming the line but not its contents |
| `HRD_MAX_LOOKUPS_PER_SYNC` | Optional. The most numbers one sync looks up, 50 when unset |

**What it reads.** Each sync looks up the numbers on the list it hasn't looked up yet, 25 to a checkpoint. HRD allows 1000 lookups a day and 100 requests in 15 minutes, so a sync looks up at most `HRD_MAX_LOOKUPS_PER_SYNC` and the rest wait for the next one. Then, once a night while HRD answers it (19:00 to 04:00 UTC), it asks which of the reports it found are still valid, 1000 numbers to a request. A report whose valid-from date moved has been reissued and is looked up again on the next sync. A number taken off the list is neither looked up again nor checked.

The client sends two requests only, `GET /GetReport/{reportNumber}` and `POST /GetReportValidities`, to `https://my.hrdantwerp.com/api/public` and nowhere else, with report numbers it checked: up to two capital letters and 6 to 14 digits. It waits a quarter second between requests, and waits out a 429 or a 5xx three times; a 400 says the token was turned down without showing it. Answers are XML, read by a small reader that refuses document type declarations and entities of its own, so nothing in an answer is expanded or fetched.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `grading.report_retrieved` | A report found by lookup. For a diamond: report type, kind (natural or lab-grown diamond, melee or other), issue date, shape, carat weight as a number, color, clarity, cut, polish, symmetry, fluorescence, measurements, inscription, remarks, hearts and arrows, origin and proportions. For a jewel: jewel type, metal, diamond count, total carat weight, description, remarks, the stones and which report types exist | report number and a hash of what is kept, so a changed report is a new event and the same one read again is a duplicate |
| `grading.report_unavailable` | A number HRD has no report for (`not_found`), or a report the validity check no longer lists (`no_longer_valid`) | report number and reason, so it is recorded once |

A report's time is its issue date; one without a readable date or number is dead-lettered with the raw event kept. PDF links are not kept, since they need the token to open. No department reasons over these events yet.

**Writes.** None. Report results are HRD's to change.

**Testing.** The tests run against a mock built from HRD's API guide (`packages/testkit/src/mocks/hrd.ts`), with synthetic diamond and jewel reports. HRD offers no sandbox; a token comes on request through MyHRD.
