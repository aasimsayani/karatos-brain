### Smile.io

Reads the store's Smile.io loyalty program: each customer's points balance and VIP tier, and every points transaction, so staff see a customer's points and tier at the counter and marketing spots lapsed members early.

| Setting | What it is |
| --- | --- |
| `SMILE_API_KEY` | A merchant API key made with only `customer:read`, `points_transaction:read` and `vip_tier:read` |
| `CUSTOMER_REF_KEY` | The instance's key for customer references |

**Read-only by design.** Smile scopes each merchant key, and a key with only read scopes can't add or take away points. Smile has no call that lists a key's scopes, so the setup asks for those three read scopes and nothing else, and the client sends only GET requests to `https://api.smile.io/v1`: List VIP tiers, List customers (with their VIP status) and List points transactions, with parameters it builds itself from checked values and Smile's page cursor, never from a link in an answer. Adjusting a customer's points is declared behind the write gate, needing approval, turned off, and the client has no request to send it. Merchant keys need Smile's Plus or Enterprise plan.

**What it reads.** Smile lists customers and points transactions newest first, 250 a page, and can filter them to those changed since a time. The first import reads everything changed in the last five years, customers first. Each later sync reads what changed since the newest change the last one saw, less five minutes; the first later sync looks back two days. An unchanged record read again is a duplicate. Each sync reads the VIP tiers first, to name each customer's tier. Each page is one batch, and the checkpoint keeps the list, its start, the newest change seen and Smile's cursor, so a resumed sync goes on from that page.

**Events.**
- `loyalty.customer_updated` for each customer, as Yotpo's are: their program state (candidate, member or disabled), points balance, VIP tier and its id, when the tier ends, their progress in the current period and when it ends, how much more keeps the tier, the next tier and how much more reaches it, and when they joined and last changed.
- `loyalty.points_changed` for each points transaction: the customer, the points added or taken away, whether they were earned or spent, and when.

Each event is keyed by a digest of what was kept. A customer without an id, a creation time, a state or a points balance, or a transaction without an id, a customer, a points change or a time, is dead-lettered.

**Privacy.** Names, birthdays, referral links, and a transaction's description and internal note are never read into an event. Customers' emails become the same customer references custom forms, Klaviyo, Quo and Yotpo make (an HMAC under `CUSTOMER_REF_KEY`).

**Referrals.** Smile's API has a referral object but no call that lists referrals, so they aren't read.

**Rate limits.** Each key gets 10 requests a second. The client waits as `Retry-After` says (up to a minute), or 1, 2 and 4 seconds, on a 429, 500 or 503, before the error goes to the sync runner, which resumes from its checkpoint next time. A 401 says the key is wrong or the plan lost API access; a 403 names the scope the key is missing.

**Testing.** Merchant keys need a paid plan. The tests run against a mock built from Smile's developer docs (`packages/testkit/src/mocks/smile_io.ts`). It checks the bearer key, each list's scope, the parameters each list takes, the sort and the page size. It lists what the first client's key must confirm: that a read-only key can't write, that `updated_at_min` holds across pages, that points and tier changes move `updated_at`, and the time format.
