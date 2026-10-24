### GIA Report Results

Looks up the GIA reports behind the certificate numbers the business holds, through GIA's Report Results API, and keeps them current. It confirms what each stone is before it is sold, insured or bought, and flags a number GIA has no report for.

| Setting | What it is |
| --- | --- |
| `GIA_API_URL` | The API address GIA gives at signup. Only https addresses on a gia.edu host are accepted, so the key can't be sent anywhere else |
| `GIA_API_KEY` | A Report Results API key, its own for KaratOS so it can be revoked alone |
| `GIA_REPORT_NUMBERS_FILE` | A text or CSV file of report numbers, one per line in the first column. Blank lines and lines starting with `#` are skipped; a line holding anything else stops the sync, naming the line but not its contents |
| `GIA_MAX_LOOKUPS_PER_SYNC` | Optional. The most new numbers one sync looks up, 100 when unset |

**What it reads.** Each sync looks up the numbers on the list it hasn't looked up yet, 25 to a checkpoint, then reads GIA's changed-reports feed from where it left off. A number is looked up once. GIA charges for lookups of reports the business didn't submit on a pay-as-you-go plan, while the feed is free and keeps every report this key has looked up current for two years, so updates come from the feed, never from a second lookup. A report at GIA for service is looked up again on a later sync. A used-up quota stops the sync with an error saying so; what was already looked up is kept.

The client sends two GraphQL queries only, `getReport` and `getChangedReports`, with variables it checked: a report number is 5 to 12 capital letters or digits. It never sends a mutation, so the changed-reports queue is read and never cleared. A 429 waits as Retry-After says, up to a minute, three times; a 403 says the key was denied without showing it.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `grading.report_retrieved` | A report found by lookup or in the changed-reports feed: report type, kind (natural or lab-grown diamond, pearl, identification, melee, narrative, jewelry or other), shape, measurements, carat weight as a number, color, clarity, cut, polish, symmetry, fluorescence, inscription, comments, origin, diamond type, proportions, which assets GIA has, and GIA's note on a reissued report | report number and a hash of the report, so an updated report is a new event and the same one read again is a duplicate |
| `grading.report_unavailable` | A number GIA has no report for (`not_found`), or won't show this key (`not_permitted`) | report number and reason, so it is recorded once |

A report's time is its report date; one without a readable date or number is dead-lettered with the raw event kept. Asset links are not stored, since GIA's last an hour; only which assets exist. No department reasons over these events yet.

**Writes.** None. Report results are GIA's to change.

**Testing.** The tests run against a mock built from GIA's developer docs (`packages/testkit/src/mocks/gia.ts`), with synthetic reports under GIA's published sandbox numbers. GIA's free plan includes a sandbox key; the nightly sandbox run looks up five sandbox reports once `SANDBOX_GIA_API_URL` and `SANDBOX_GIA_API_KEY` are set.
