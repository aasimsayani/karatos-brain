### Gem Logic

Reads the products a jewelry business lists on each of its Gem Logic sales channels, so stock can be followed across the counter and the web. Each arrives as a `product.updated` event.

| Setting | What it is |
| --- | --- |
| `GEM_LOGIC_API_KEY` | A Gem Logic API key made for KaratOS under Settings > API |
| `GEM_LOGIC_INSTANCE` | The business's instance: `example` in `example.gem-logic.com`, as a name, host or URL |

**Read-only by design.** Gem Logic signs a request in with an API key in the `x-api-key` header. A key can't be limited: the same key can make sales and repairs and upload images. So the client keeps to the reads itself. It sends only GET requests, to `/api/marketplaces/` and `/api/products/{marketplace_id}`, on the one instance the settings name. No writes are declared. Gem Logic's own error text is never repeated in an error, only the HTTP status. To cut KaratOS off, deactivate the key.

**What it reads.** Gem Logic lists products by sales channel and has no filter for when they changed, so each pass reads every channel's products: the historical import once, and every later sync again. A product read again unchanged is a duplicate, so only a new or changed one is ingested. Each page is one batch and one checkpoint, which keeps the channel and the next page; a channel that has moved in the list since starts the pass over.

**Events.** A product has its SKU, status, the channel it is listed on, when it was made, how many images it has, and its weight, height, length and width. Each is keyed by its channel, its ID and a digest of what was kept. One without an ID or a time that reads is dead-lettered.

**Not read.** Sales (the API lists only their order IDs, with no date), repairs (the API can only create them), contacts (names, emails and phones) and image links.

**Rate limits.** Gem Logic documents none. The client waits out a 429, 500, 502, 503 or 504 three times, honoring `Retry-After` in seconds up to a minute, before the error goes to the sync runner, which resumes from its checkpoint next time.

**Testing.** The tests run against a mock built from Gem Logic's API page (`packages/testkit/src/mocks/gem_logic.ts`). The mock lists what a trial run must confirm: whether lists come whole or in pages under `results`, and that products list in a stable order.
