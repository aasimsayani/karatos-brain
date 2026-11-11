### nFusion Solutions metals feed

Spot prices for gold, silver, platinum and palladium from nFusion Solutions' Market Data API at `https://api.nfusionsolutions.biz`, in US dollars per troy ounce, as the metals department's `metal.price_updated` events: the same shape the Metals-API connector gives, so either feed drives melt values for inventory and gold bought from the public, and the metals department's alert when a price moves. The connector was built from nFusion's OpenAPI spec ([apis.guru mirror](https://api.apis.guru/v2/specs/nfusionsolutions.biz/1/openapi.json)) and its [support page](https://nfusionsolutions.com/support/).

| Setting | What it is |
| --- | --- |
| `NFUSION_TOKEN` | The Market Data API token from the nFusion dashboard, under Connections, then API Keys |

**Access.** nFusion issues credentials under a service agreement, or through a [free trial](https://nfusionsolutions.com/free-trial/); there is no public pricing and no sandbox.

**Sign-in.** nFusion takes the token as the `token` query parameter. nFusion doesn't publish the token's format, so the connector accepts 8 to 256 letters, digits, `_` or `-`, and checks it before anything is sent. Because the token is in the URL, a request URL is never put in an error, a log or an error's cause, and any text nFusion sends back has the token, any `token=` pair and any URL masked before it is quoted. A 401, or a 403 that isn't the rate limit, stops the sync with a message naming `NFUSION_TOKEN`.

**What it reads.** Only two GETs, both with `currency=USD`, `unitofmeasure=toz` and `format=json`:

- `GET /api/v1/Metals/spot/history` with `metals=gold,silver,platinum,palladium`, `start`, `end` and `interval=1d`, for daily closes. The historical import reads five years ending yesterday, 90 days a request (21 requests). The checkpoint fixes the first and last day when the import starts and counts the requests already read, so a resumed import asks for exactly the same stretches. nFusion doesn't say whether `end` is kept, so each request asks through the day after its stretch and keeps only the stretch's days.
- `GET /api/v1/Metals/spot/summary` with the same metals, for the latest quote. Each incremental sync reads the daily closes from the last day it kept (the last 7 days the first time) through today, then the summary.

**Rate limits.** nFusion asks for fewer than one call a second per service, so requests are spaced at least 1.1 seconds apart. Its rate limit answers HTTP 403 with substatus 502. nFusion doesn't say how the substatus reaches the client, so a 403 whose body says `403.502` (as IIS writes it), or that names a substatus of 502 in its body or a header, is the rate limit. It, a 429, and a 500, 502, 503 or 504 are retried three times, honoring `Retry-After` up to a minute or else waiting 1, 2 and 4 seconds, before the sync stops and resumes from its checkpoint.

**Events.** Each price is `{ metal, spotPerTroyOunceCents, quote, priceDate }`. A daily close (`quote: "daily"`) is the interval's `last`, keyed by metal and day, and stands for the interval's end; a day not over yet is left for the next sync. A latest quote (`quote: "latest"`) is the summary's `last`, keyed by metal and nFusion's `timeStamp`. So a replay is a duplicate. nFusion also gives bid, ask, open, high and low, but the department's schema keeps only the metal and price, so they are left out. Each metal has its own `success` and `error` in the answer: a metal that failed, or isn't in USD per troy ounce, is dead-lettered with what was wrong, as is an interval or quote whose times or price don't read (under a cent or over a million dollars an ounce counts as not reading). A day with no close (`last` null) is skipped.

**Writes.** None: the API is GET-only market data, and the client has no way to send anything else.

**Testing.** There is no sandbox. The mock (`packages/testkit/src/mocks/nfusion.ts`) is built from the OpenAPI spec, and its assumptions list what the first live run with a token must confirm, among them the token's format, the `start` and `end` format, whether `end` is kept, and how the 403 substatus 502 shows.
