### WatchBase Data Feed

Reads reference specs for the watch brands a store deals in through the WatchBase Data Feed API, v1, at `https://api.watchbase.com/v1` ([datafeed manual](https://watchbase.com/manuals/datafeed), [API entry points](https://watchbase.com/manuals/datafeed/1/en/topic/api-entry-points)): each watch model's brand, family, reference number, caliber, case, dial and water resistance. WatchBase is reference data, not store activity, so each watch arrives as its own event type, `watch_reference.updated`, the way the other reference feeds have theirs.

| Setting | What it is |
| --- | --- |
| `WATCHBASE_API_KEY` | The API key of a WatchBase datafeed account |
| `WATCHBASE_BRANDS` | The brands to read, by WatchBase brand name or BrandID, comma or newline separated, up to 50 |
| `WATCHBASE_MAX_WATCHES` | Optional: the most watches one sync reads, 1 to 10000; 200 when unset |

**Sign-in.** A store signs up for a datafeed account on WatchBase and buys DataFeed credits (one credit is one cent); each watch entry costs US$0.25, and the feed has no images ([datafeed manual](https://watchbase.com/manuals/datafeed)). The account's key goes in every request as the `key` parameter, with `format=json` and a User-Agent naming KaratOS. The Data Feed API only gives data, so the key can only read. Because the key is in the URL, a request URL is never put in an error or log, and any text WatchBase sends back has the key, any `key=` pair and any URL masked before it is quoted. The key is checked before anything is sent: WatchBase gives no format, so it must be 16 to 128 letters, digits, `_` or `-`. A 401 or 403 stops the sync with a message saying `WATCHBASE_API_KEY` must be the key of a datafeed account with credits left.

**What it reads.** `GET /brands` once a sync, only when `WATCHBASE_BRANDS` names a brand rather than giving its BrandID ([brands](https://watchbase.com/manuals/datafeed/1/en/topic/brands)); a name WatchBase doesn't list stops the sync with that name. Then for each brand `GET /watches?brand-id=...` ([watches](https://watchbase.com/manuals/datafeed/1/en/topic/watches)), and `GET /watch?id=...` for each watch listed ([watch](https://watchbase.com/manuals/datafeed/1/en/topic/watch)), in id order, 25 to a batch. Each watch read is charged, and a watch's specs have no history: WatchBase gives each watch's current version. So:

- The historical import reads nothing and finishes at once. The sync runner runs it once and marks it complete even when it stops early, so a capped import there would lose its place.
- Each sync reads the catalog. A brand not read before is read in full: every watch it lists. After that, a sync asks only for the watches created or modified after the day before the brand was last read (`updated-since`), and reads those. So a brand added to the setting later is read in full the first time. A brand is read at most once a day.
- A sync reads at most `WATCHBASE_MAX_WATCHES` watches, then stops; the next sync goes on where it stopped. So reading a large catalog is spread over several syncs, and no sync spends more than the store allows.

The checkpoint keeps the day each brand was last read, and the open pass: the day it began, and the brand and last watch id it got to. A resumed sync lists that brand again and goes on after that id. WatchBase gives no rate limit; a 429 (or a 500, 502, 503 or 504) is retried three times, honoring `Retry-After` up to a minute or else waiting 1, 2 and 4 seconds, before the sync stops and resumes from its checkpoint.

**Events.**

- `watch_reference.updated` for each version of a watch: its WatchBase id, brand and BrandID, reference number, name, family, gender, release year and water resistance in meters; its caliber (reference, maker, type, display, jewels, diameter in mm, power reserve in hours, hands); its case (materials, coating, glass, back, shape, diameter, height and lug width in mm); its dial (color, finish, index type, hand style); and the days it was added and modified. It is keyed by the watch's id, its modified day and a digest of what is kept, so reading it again unchanged is a duplicate and a change is a new event.

No description, image, logo, thumbnail, brand website or slug is kept: WatchBase can't license its images. A measurement that doesn't read with its unit, such as `49.70 mm`, is left out. A watch without an id, reference number, brand or modified day, and a listed watch without an id, is dead-lettered with what was wrong, never guessed.

**Writes.** None: WatchBase only gives data, and nothing is declared to write.

**Testing.** WatchBase has no sandbox. The mock (`packages/testkit/src/mocks/watchbase_datafeed.ts`) is built from WatchBase's datafeed manual, which shows only XML answers; its assumptions list what the first live run on a datafeed account must confirm, among them the shape of the JSON answer, the error format, and whether `updated-since` includes the day given.
