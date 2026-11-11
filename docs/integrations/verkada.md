### Verkada store traffic

Reads how many people came into the store and went out, hour by hour, from each Verkada camera's counting line, so the owner sees footfall against sales.

| Setting | What it is |
| --- | --- |
| `VERKADA_API_KEY` | A read-only API key from the organization's admin |
| `VERKADA_REGION` | `us` (the default) or `eu`, where the organization's data lives |

**Read-only by design.** Verkada API keys are made read-only or read/write, and their permissions can't change later, so the setup asks the admin for a read-only key. The connector trades it for a token that lasts 30 minutes (`POST /token` with the key in `x-api-key`), sends the token in `x-verkada-auth`, and sends only two GETs: the cameras with Occupancy Trends turned on and their counting lines, and the hourly counts across a line. It declares no writes.

**What it reads.** Verkada answers one camera's line at a time, over a time range, by hour. A pass lists the cameras and their lines, then reads each line a week at a time up to the last whole hour. The first import reads two years back. Each later sync reads from two hours before where the last one ended, since Verkada can still be counting the last hours; the first later sync reads the last day. An hour read again unchanged is a duplicate, and a recount is a new event. Each week of a line is one batch, and the checkpoint keeps the pass's range, its lines and where it is, so a resumed sync goes on from there.

**Events.** `store.traffic_counted` for each hour across each counting line: the camera and line, the camera's name and site, the hour's start and end, and how many people came in and went out. It is dated at the end of its hour. An hour that doesn't read, or an answer for another camera, is dead-lettered.

**Privacy.** Counts only: the site's street address, the organization's name and any video or thumbnail are never read into an event.

**Rate limits.** Verkada allows 300 calls a minute for an organization, enforced 25 to each five seconds, so the client spaces calls a quarter second apart. It waits 5, 10 and 20 seconds on a 429, 500, 502, 503 or 504 before the error goes to the sync runner, which resumes from its checkpoint next time. The token is kept until five minutes before it lapses and fetched again once if a call is turned down. A 401 on the token says the key is wrong, expired or in the other region; a 403 says the key can't see the cameras.

**Testing.** Occupancy Trends needs Verkada cameras with the feature on. The tests run against a mock built from Verkada's API docs (`packages/testkit/src/mocks/verkada.ts`). It checks the token, the parameters, the camera and line, and the range. It lists what the first client's organization must confirm: the key the cameras come under, the shape of each hour's entry, that a week at a time is one answer, how lines are picked, and the key's shape.
