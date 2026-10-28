### Metals-API

Spot prices for gold, silver, platinum and palladium from [Metals-API](https://metals-api.com/documentation), in US dollars per troy ounce, as the metals department's `metal.price_updated` events. They feed melt values for inventory and for gold bought from the public, and the metals department's alert when a price moves 5% or more.

| Setting | What it is |
| --- | --- |
| `METALS_API_KEY` | The access key from the Metals-API dashboard |
| `METALS_API_HISTORY_DAYS` | Optional. Days of daily closing prices the first import reads, 1 to 1825. A year when empty |

**What it reads.** The historical import reads one closing price a day for each metal, ending yesterday, since Metals-API won't give a timeseries that includes today. Each request covers up to 30 days of one metal, so a year costs 52 requests and five years 244: check the plan's monthly allowance before raising `METALS_API_HISTORY_DAYS`. The checkpoint fixes the first and last day when the import starts and counts the requests already read, so a resumed import asks for exactly the same stretches. Each incremental sync reads the latest prices for all four metals in one request.

**Prices.** With US dollars as the base, Metals-API sends `XAU` as troy ounces per dollar, so the price is its inverse; the latest endpoint also sends `USDXAU`, the price itself, which wins when present. Prices are stored as whole cents. A quote that is missing, zero, negative or absurd (under a cent or over a million dollars an ounce) is skipped rather than stored. An answer in any base other than US dollars stops the sync.

**Events.** A daily close is keyed by metal and day and stands for the end of that day (`23:59:59Z`); a latest quote is keyed by metal and the time Metals-API gives it. Both carry `quote` (`daily` or `latest`) and `priceDate`.

**Read-only.** The client sends only GET requests with no body, to the latest and timeseries endpoints, for the four metal codes. Metals-API takes the key as the `access_key` query parameter, so request URLs are never put in errors, and an error message that repeats the key has it replaced with `[key]`. There is nothing to write back, and Metals-API has no webhooks.

**Testing.** The tests use a stand-in for the API built from its documentation, with synthetic prices. For the nightly sandbox run, sign up for a free Metals-API account and add its key as the `SANDBOX_METALS_API_KEY` GitHub Actions secret. The run reads a week of history to stay within the free plan's allowance.
