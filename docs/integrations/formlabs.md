### Formlabs

Reads the print runs a workshop's Formlabs printers made, so castable wax and resin models can be followed from the queue to a finished print. Each arrives as a `manufacturing.print_updated` event.

| Setting | What it is |
| --- | --- |
| `FORMLABS_CLIENT_ID` | The client ID of Developer API credentials made for KaratOS on Formlabs Dashboard |
| `FORMLABS_CLIENT_SECRET` | Their client secret |

**Read-only by design.** Formlabs signs a request in with a token that lasts a day, made from the credentials with the client credentials grant at `POST /developer/v1/o/token/`. A token can't be limited: the same one can create and change printer groups. So the client keeps to the reads itself: it sends that one POST and otherwise only GET requests to `/developer/v1/prints/`, all on `api.formlabs.com`. No writes are declared. Formlabs' own error text is never repeated in an error, only the HTTP status. The API needs a Formlabs account with at least one printer registered to Dashboard.

**What it reads.** The first import lists a year of print runs by when they were made (`date__gt`, `date__lt`), 100 to a page. Each later sync lists the runs made from three days before the last pass ended, so a run still printing then is read again once it finishes. A pass lists runs between two fixed times, so new runs don't shift its pages, and each page is one batch and one checkpoint.

**Events.** A run has its printer, printer group, status (queued, printing, finished, aborted, error and the rest), whether it succeeded, the resin's code and name, its volume in millilitres, its layers and layer thickness, how many parts it holds, its estimated and elapsed time, and when it was made, started and finished. Each is keyed by a digest of what was kept, so an unchanged run is a duplicate and a run that finishes is a new event. One without an ID or a time that reads is dead-lettered.

**Privacy.** A print's name isn't kept, since workshops often name a job after the customer, and neither are the user who sent it, notes, messages, part names, thumbnails or photo links.

**Rate limits.** Formlabs allows 100 requests a second per IP and 1,500 an hour per user, and answers 429 with `Retry-After` past that. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time. A token turned down mid-pass is replaced once.

**Testing.** The tests run against a mock built from the published reference (`packages/testkit/src/mocks/formlabs.ts`). The mock lists what a live run must confirm: that `date__gt` and `date__lt` match `created_at`, and that runs list in a stable order.
