### Search The Watch Market

Reads the market prices, days to sell and 13 weeks of price history for each watch reference the store follows, so the store sees a fair price and how fast a reference sells before it buys, takes a trade-in or prices a watch.

| Setting | What it is |
| --- | --- |
| `STWM_API_KEY` | The Business API key, from API Access in the store's account |
| `STWM_REFERENCES` | The references or names the store follows, comma or newline separated, up to 200 |

**Read-only by design.** The Business API only answers GETs. The connector sends four, with the key as a Bearer token: resolving a reference to its model group, the model's latest prices, its days to sell, and its weekly price history. It declares no writes.

**What it reads.** The API keeps no history past 13 weeks, so the historical import is one pass over the references and each later sync is another. Each reference is resolved to its model once, and the model is kept in the checkpoint, so later passes spend three calls on it. Two references for the same model are read once. Each reference is one batch, and the checkpoint keeps the pass's references, its day and its place, so a resumed sync goes on from there.

**Events.** `watch_market.price_observed` for each model each day it is read: the reference, brand, model number and name, the currency, the number of listings, the low, high and mean asking price, the market value, and the days half and 95% of listings take to sell. `watch_market.price_week` for each complete week of history: the low, high and mean in each currency quoted, and the number of listings. A reference that matches no model, and an answer that doesn't read, are dead-lettered.

**Allowance.** A plan allows 1,000 or 5,000 calls a day, shared with the vendor's own assistant access, and resets at midnight UTC. The client keeps the allowance left from `X-RateLimit-Remaining`, and a pass stops early, to go on next time, when 25 calls would be left. A 429 isn't retried, since it lasts until midnight; the sync runner keeps the checkpoint. A 500 or 503 is waited out 5, 10 and 20 seconds. Calls are spaced a quarter second apart.

**Testing.** The Business API needs a paid plan. The tests run against a mock built from the vendor's API reference (`packages/testkit/src/mocks/search_the_watch_market.ts`). It lists what the first client's key must confirm: the key's shape, that a week's date is its first day, and how a 429 answers.
