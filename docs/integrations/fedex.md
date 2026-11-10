### FedEx tracking

Follows the FedEx packages on the business's list, such as repairs going out to a setter, memo goods and customer orders, through FedEx's free Track API. It shows where each is, flags a delivery exception as soon as FedEx records one, and says which parcels needed a signature.

| Setting | What it is |
| --- | --- |
| `FEDEX_CLIENT_ID` | The API key of a FedEx Developer Portal project with only the Track API chosen |
| `FEDEX_CLIENT_SECRET` | That project's secret key |
| `FEDEX_TRACKING_NUMBERS_FILE` | A text or CSV file of tracking numbers, one or more a line, split by spaces, commas or semicolons. Lines starting with `#` are skipped, and anything that isn't 12 to 34 digits or a door tag (DT and 12 digits) is left out |
| `FEDEX_ENVIRONMENT` | Optional. `production` (the default) or `test`, FedEx's sandbox |
| `FEDEX_MAX_TRACKING_PER_SYNC` | Optional. The most numbers one sync reads, 500 when unset |

**What it reads.** It works the way UPS tracking does, with the same shared tracking logic: each sync reads every number on the list that isn't delivered or returned yet, oldest first, 25 to a checkpoint, and a number that never gets there is dropped 120 days after it was first read.

The client signs in with the API key and secret (OAuth client credentials, sent as a form) and keeps the token until five minutes before it runs out. It calls `POST /track/v1/trackingnumbers` only, one number a call, with a fresh `x-customer-transaction-id` and no detailed scans. A 401 signs in again once; a 429 or 503 waits as Retry-After says, up to a minute, three times. A number FedEx has nothing for comes back as an error on its track result and is read again next sync.

**Events.** `shipment.tracked`, as for UPS: status from FedEx's derived code (or its code), FedEx's code and text, latest scan time in UTC, the estimated delivery day, the delivered day, the service, whether a direct, adult or indirect signature was asked for, and the destination's state and country. Days are the local day FedEx wrote. Names, street addresses, postal codes, who received or signed, declared values and proof-of-delivery images are never kept.

**Writes.** None. KaratOS never creates labels, pickups or returns, and doesn't make tracking subscriptions.

**Testing.** FedEx's request and response schemas sit behind a page this project can't read, so the mock (`packages/testkit/src/mocks/fedex.ts`) is built from FedEx's public catalog page and public sample responses, and its assumptions list what the first live run must confirm: the token form, the status codes and the not-found error. The nightly sandbox run signs in at FedEx's sandbox and reads two of its test numbers once `SANDBOX_FEDEX_CLIENT_ID` and `SANDBOX_FEDEX_CLIENT_SECRET` are set.
