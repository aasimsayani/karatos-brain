# Verifying synced numbers

Sync verification shows that the numbers an instance reports match the source system's own numbers. For a period you choose, the instance asks each connected system for its totals and counts what it has synced for the same period. It then compares the two sides, metric by metric, and lists the ids of any records that are on one side only.

Use it once a client's systems are connected and their history has imported. It is also worth running after a connector change, or whenever a figure in the [daily brief](daily-brief.md) looks wrong.

## What it checks

| System | Metrics | Source side (read-only, existing scopes) | Synced side |
| --- | --- | --- | --- |
| Shopify | `sale_count`, `gross_sales` | Orders processed in the period that are paid, partly paid, partly refunded or refunded, with a total above zero, at their original total. Read with the orders query the connector already syncs with (`read_orders`) | `sale.completed` events from Shopify dated in the period, at their `totalCents` |
| Shopify | `refund_count`, `refund_total` | Refunds created in the period that return at least one item, at the sum of the returned items' subtotals. Read with the same orders query (`read_orders`), from orders updated since the period began and created before it ended | `sale.returned` events from Shopify dated in the period, at the sum of their items' `refundCents` |
| Square | `sale_count`, `gross_sales` | Orders closed in the period that completed, with a total above zero, at their total before returns, across every location. Read with Search Orders and List Locations (`ORDERS_READ`, `MERCHANT_PROFILE_READ`) | `sale.completed` events from Square dated in the period |
| Square | `refund_count`, `refund_total` | Returns with at least one item in orders closed in the period that completed, at the sum of the returned items' totals. Read from the same Search Orders pages, so no extra call | `sale.returned` events from Square dated in the period, at the sum of their items' `refundCents` |
| Stripe | `charge_count`, `charge_gross` | Charges created in the period that succeeded, at the amount captured before refunds. Read from the charges list with the read-only restricted key | Each charge's latest synced `payment.charge_updated` state, counted when it succeeded with something captured |
| Stripe | `refund_count`, `refund_total` | Refunds created in the period that succeeded, at their amount. Read from the refunds list the connector already imports, with the same key | Each refund's latest synced `payment.refund_updated` state, counted when it succeeded with an amount |
| Klaviyo | `profile_count` | Profiles created in the period. Read from the profiles list (`profiles:read`), asking for each profile's created and updated times only, so no email address or phone number is read | Profiles synced from Klaviyo whose creation time falls in the period, each counted once |

None of these systems has a count or total call that the connector's scopes allow. Shopify's aggregate reports need `read_reports`, which the connector doesn't ask for. So each check pages through the records with the same read calls the sync makes, and adds them up. No new scope is needed, and nothing is ever written to a vendor. A check reads at most 50,000 records from a system. Past that, the system is reported as unavailable, and you should verify a shorter period. For Shopify refunds, the same limit applies to the orders read. Every order updated since the period began is read, so an old period on a busy store can reach the limit sooner than a recent one.

Other systems aren't checked yet. If you name one, it is reported as unavailable with "KaratOS can't verify it yet".

## The rules

- **Periods are store days.** `from` and `to` are days on the store's calendar, in `STORE_TIME_ZONE`, and both days are included. A day runs from local midnight to local midnight. That makes it 23 or 25 hours long on the days the clocks change, as in the brief. A sale at 11:30 pm Eastern on the 18th belongs to the 18th. A period can be up to 92 days long and can't end after today.
- **Counts must agree exactly, and so must the records behind them.** A period where one sale is missing and another is extra has equal counts. It is still a mismatch, and both ids are listed.
- **Money is compared in whole cents.** It matches only if three things hold: every record is on both sides, no record's amount differs by more than the tolerance, and the totals differ by no more than the tolerance. The tolerance is 0 cents unless the request sets `toleranceCents`, which can be up to 100.
- **Sales are gross, before refunds, on the day of the sale**, as the brief counts gross. A refunded or partly refunded order still counts on its sale day, at its original total. A cancelled order that was never paid (voided, pending, authorized) was never a sale, so it counts on neither side.
- **Refunds are their own records, on the day each one was made.** A refund made on the 20th of a sale from the 5th counts on the 20th, whatever happened to the sale. Each refund is matched by its own id (`shopify:refund:<id>`, `square:return:<order>:<uid>`, `stripe:refund:re_...`), so an order refunded in two parts is two records, and a missing partial refund is named even when the totals are close.
- **Store refunds are counted as the brief counts them.** For Shopify and Square, the brief's refund figure is the `sale.returned` events: each one once, at the sum of its returned items' refunds. Verification counts the same records on both sides. So a Shopify refund with no returned items (only shipping, or a goodwill amount) isn't counted on either side, because the sync doesn't record it as a return. Its money is in the order's status, not in the brief's refunds. A return line whose amount can't be read makes the synced event uncountable, and the return shows as missing.
- **Square's refunds are its returns.** A Square return is part of an order of its own, closed on the day the items came back. The refunds of payments that the connector also syncs from Square's Refunds API (as `payment.refund_updated`) are the money side of the same returns. The brief doesn't count them as refunds, so they aren't checked here.
- **Stripe's refunds are its own refunds list.** Stripe records payments, not items, so there is no `sale.returned` from Stripe. Its refunds are compared with the `payment.refund_updated` states that synced, the latest received for each refund. Only a refund that succeeded counts. One that is pending, failed, cancelled or waiting on the customer doesn't.
- **A record synced twice is extra.** The brief counts every sale event, so a duplicate would inflate its figures, and verification lists it.
- **An unreadable synced record makes the synced side a floor.** Retention may have cleared an event's payload (see [data retention](architecture/data-retention.md)), or the payload may be unreadable. Either way the event can't be counted. The system then reports `uncountedEvents`. Verify periods inside `RAW_RETENTION_DAYS` to compare everything.
- **Missing sales are often the check working.** Shopify counts some paid orders that the connector couldn't record as sales, such as an order with more than 50 lines or a line without a price. These show as missing, so you can find them.

## Calling it

`POST /v1/verify` with the instance API key. The support key gets 403. Only one verification runs at a time. A second request while one is running gets 429, and no request is queued.

```bash
curl -X POST https://<instance-host>/v1/verify \
  -H "Authorization: Bearer $INSTANCE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"system": "shopify", "from": "2026-11-01", "to": "2026-11-15"}'
```

| Field | Required | Meaning |
| --- | --- | --- |
| `from` | yes | First store day, `YYYY-MM-DD` |
| `to` | yes | Last store day, included |
| `system` | no | One integration id. Without it, Shopify, Square, Stripe and Klaviyo are checked, one after another |
| `toleranceCents` | no | Largest money difference that still matches, 0 to 100. 0 by default |

The answer is `{ "verification": { generatedAt, period, summary, systems } }`:

- `period` has `startDay`, `endDay`, `timeZone` and the instants `from` and `to` that it covers.
- `summary` counts the systems by status: `match`, `mismatch` and `unavailable`.
- Each item in `systems` has `system`, `status`, `period`, `metrics`, and `basis` (one line each on how the source and synced sides were counted). It has `uncountedEvents` when some synced events couldn't be read, and `reason` when the system couldn't be verified.
- Each metric has `metric`, `unit` (`count` or `cents`), `status`, `sourceTotal`, `syncedTotal` and `difference` (synced less source). It also has `missing` (in the source system, not synced) and `extra` (synced, not in the source system). Money metrics add `amountDiffers` and `toleranceCents`. Each difference is `{ count, sample }`, where `sample` holds up to 20 record ids, sorted.

A system is `unavailable` when any of these is true:

- It isn't in `ENABLED_INTEGRATIONS`.
- It is turned on but missing settings (the reason names the settings).
- KaratOS can't verify it yet.
- Its connector has no verify support.
- The source system couldn't be read. The reason names the error class and HTTP status, never the vendor's message.
- There were too many records to check.
- For Shopify's refund metrics only: an order in the period has more than 10 refunds, or a refund has more than 50 line items. The connector reads that many per order, so some refunds couldn't be seen. The reason names the order (`shopify:order:<id>`), so you can check it in Shopify. The sales metrics are still compared. The system is then unavailable as a whole, because one of its metrics is.

An unknown system id, a malformed day, a period that runs backwards, ends after today or is longer than 92 days, or any other field gets 400.

### What the output never holds

The ids are record references only: `shopify:order:1001`, `shopify:refund:<id>`, `square:order:<id>`, `square:return:<order>:<uid>`, `stripe:charge:ch_...`, `stripe:refund:re_...`, or a Klaviyo profile's keyed reference (never its Klaviyo id). A refund's reason, its note and what was returned are never in the output. The output never includes a customer name, email address, phone number, address or raw payload. Vendor error messages are left out, because they can quote what the vendor sent back.

## From the command line

`npm run verify-sync` calls one instance and prints the result. It reads the instance key from `INSTANCE_API_KEY`, never from a flag, so the key stays out of shell history. It sends the key only to `POST /v1/verify` on the instance's own host and follows no redirect.

```bash
INSTANCE_API_KEY=... npm run verify-sync -- --url https://<instance-host> --from 2026-11-01 --to 2026-11-15
INSTANCE_API_KEY=... npm run verify-sync -- --url https://<instance-host> --from 2026-11-01 --to 2026-11-15 --system stripe --json
```

| Option | Meaning |
| --- | --- |
| `--url` | The instance's address. It must be https; plain http is allowed only for localhost |
| `--from`, `--to` | Store days, both included |
| `--system` | One integration id |
| `--tolerance-cents` | As `toleranceCents` |
| `--json` | Print the JSON answer instead of the report |

It exits 0 when every system matches, 1 for a mismatch or a system that couldn't be verified, and 2 when the check couldn't run. Anything it prints has the key replaced with `[redacted]`.
