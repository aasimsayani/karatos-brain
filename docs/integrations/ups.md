### UPS tracking

Follows the UPS packages on the business's list, such as repairs going out to a setter, memo goods and customer orders, through UPS's free Tracking API. It shows where each is, flags a delivery exception as soon as UPS records one, and says which parcels needed a signature or went UPS Premier.

| Setting | What it is |
| --- | --- |
| `UPS_CLIENT_ID` | The Client ID of a UPS developer app with only the Tracking product added |
| `UPS_CLIENT_SECRET` | That app's Client Secret |
| `UPS_TRACKING_NUMBERS_FILE` | A text or CSV file of tracking numbers, one or more a line, split by spaces, commas or semicolons. Lines starting with `#` are skipped, and anything that isn't 7 to 34 letters and digits is left out |
| `UPS_ENVIRONMENT` | Optional. `production` (the default) or `test`, UPS's Customer Integration Environment |
| `UPS_MAX_TRACKING_PER_SYNC` | Optional. The most numbers one sync reads, 500 when unset |

**What it reads.** UPS keeps no feed of changes, so each sync reads every number on the list that isn't delivered or returned yet, oldest first, 25 to a checkpoint. A delivered or returned package is never read again, and a number that never reaches either is dropped 120 days after it was first read. A number taken off the list is forgotten. The historical import and the incremental sync do the same; a status that hasn't changed comes back as a duplicate.

The client signs in with the client id and secret (OAuth client credentials) and keeps the token until five minutes before it runs out. It calls `GET /api/track/v1/details/{number}` only, with a fresh `transId` each time, and asks for no signature image, proof of delivery or milestones. A 401 signs in again once; a 429 or 503 waits as Retry-After says, up to a minute, three times. A number UPS doesn't know (404, or a 200 with only a warning) is skipped and read again next sync.

**Events.**

| Event | From | Key |
| --- | --- | --- |
| `shipment.tracked` | One package's tracking: status (`label_created`, `picked_up`, `in_transit`, `out_for_delivery`, `delivered`, `exception`, `returned` or `unknown`), UPS's status code and text, latest scan time, scheduled or rescheduled delivery day, delivered day, service, whether a signature was asked for, UPS Premier level, and the destination's state and country | tracking number and a hash of what was kept, so a new scan is a new event and the same status read again is a duplicate |

A package's time is its latest scan, or when it was read when UPS has no scan yet. Names, street addresses, postal codes, who signed, signatures, photos, proof of delivery and payment details are never kept, even when UPS sends them. No department reasons over these events yet.

**Writes.** None. KaratOS never creates labels, pickups or returns.

**Testing.** The tests run against a mock built from the OpenAPI files UPS publishes (`packages/testkit/src/mocks/ups.ts`), with synthetic packages. UPS's status type letters aren't listed in those files, so the mock's assumptions name them for the first live run to check. The nightly sandbox run signs in at UPS's test environment and reads two of UPS's test tracking numbers once `SANDBOX_UPS_CLIENT_ID` and `SANDBOX_UPS_CLIENT_SECRET` are set.
