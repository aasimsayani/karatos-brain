# Departments

Brain A covers a jewelry business one department at a time. Each department is a module in [`@karatos/retail`](../../packages/retail) that brings four things:

1. **Events** it owns, each with a payload schema. A payload that doesn't match is dead-lettered with the exact problem, never half-stored.
2. **Normalizers** that turn events into entities (customers, products, repair tickets and so on).
3. **Extractors** that turn events into signals in shared memory.
4. **Reasoners** that read signals from any department and raise recommendations with confidence, expected impact and provenance.

Retail comes first. Manufacturing (bench work, casting, stone setting, production planning) is next and will be its own package built on the same contract.

## Turning departments on

Set `ENABLED_DEPARTMENTS` on the instance to a comma-separated list of ids. Leave it empty to run all of them. An unknown id stops the instance at startup with the list of valid ids.

```
ENABLED_DEPARTMENTS=sales,inventory,clienteling,repairs
```

A department's events are only validated when it is enabled, and departments that read other departments' signals (compliance, finance) need those departments enabled to have anything to read.

## Retail departments

| Id | Department | Events it owns | What it raises |
| --- | --- | --- | --- |
| `sales` | Sales and POS | `sale.completed`, `sale.returned` | SKUs returned 25% of the time or more (once 4 or more have sold) |
| `inventory` | Inventory and Merchandising | `inventory.received`, `inventory.adjusted`, `inventory.counted` | Pieces unsold for 270 days, with their gold melt value; reorders when 1 or fewer are left and 2 or more sold in 60 days; items whose stock counts disagree between systems (see [checking stock counts agree](#checking-stock-counts-agree)) |
| `clienteling` | Clienteling and CRM | `customer.profile_updated`, `customer.occasion_recorded`, `wishlist.item_added` | Birthdays and anniversaries within 21 days (only for customers who consented to marketing), with their wish list; VIPs with $5,000+ lifetime spend and no purchase in a year |
| `repairs` | Repairs and Service | `repair.received`, `repair.status_changed` | Repairs past their promised date; pickup reminders after 30 days ready; a final-notice review after 180 days |
| `custom_orders` | Custom and Special Orders | `custom_order.created`, `custom_order.stage_changed`, `custom_order.payment_received` | Orders stuck 14 days in one stage; orders due within 7 days (or overdue) that haven't reached finishing; balances due when ready |
| `appraisals` | Appraisals | `appraisal.completed` | Insurance appraisals more than 3 years old |
| `buying` | Buying, Vendors and Memo | `memo.received`, `memo.settled`, `purchase_order.created`, `purchase_order.received` | Memo goods due back within 14 days (pay if sold, return if not); late purchase orders |
| `metals` | Metals and Gold Buying | `metal.price_updated`, `gold_purchase.completed` | Spot moves of 5% or more, with the pieces affected; gold bought at more than 85% of melt |
| `marketing` | Marketing | `campaign.sent`, `campaign.sale_attributed` | After 14 days, campaigns returning 3x or more (repeat them) or less than 1x (rethink them) |
| `finance` | Finance | `bank.transaction_imported`, `bank.account_updated`, `accounting.invoice_updated`, `accounting.record_deleted` | Cash sales over 30 days that are more than 5% (and $200) above cash deposits; $500 or more in US dollar invoices more than 30 days past due. Keeps each bank account's balance (`bank.balance`) and each invoice with what is still owed (`receivable.invoice`, or `receivable.removed` once deleted) as signals for the console. Matches payment processors' payouts to the sales they pay for and raises payouts that are short, missing or late (see [matching payouts to sales](#matching-payouts-to-sales)) |
| `compliance` | Compliance | none, it reads other departments | IRS Form 8300 for cash over $10,000 in 24 hours, with the 15-day deadline; possible structuring across 30 days; gold bought from the public without seller ID |

Compliance recommendations are reminders for the owner, not legal advice. State rules for secondhand dealers and unclaimed property differ, so those recommendations say to follow the state's rules rather than naming a period.

## How departments feed each other

These links already exist, and each one makes both departments more useful than they'd be alone:

- **Sales → inventory:** sell-through drives aged-stock and reorder recommendations.
- **Sales → clienteling:** lifetime value finds lapsed VIPs.
- **Sales → compliance and finance:** cash payments drive Form 8300, structuring and deposit checks.
- **Metals → inventory:** spot prices value aged gold pieces at melt.
- **Store systems → inventory:** each system's stock count of an item is checked against the others'.
- **Metals → gold buying:** spot prices check what was paid for gold bought from the public.
- **Clienteling → sales:** wish lists appear in occasion reminders.
- **Payments → finance:** each processor's payouts are matched to the sales, refunds and fees they cover.

See [compounding value](../vision/compounding-value.md) for why these links matter more as departments are added.

## Adding a department

1. Create `packages/retail/src/departments/<name>.ts` exporting a `DepartmentModule`.
2. Give every event a zod schema. Event types must be unique across departments; `combineDepartments` refuses duplicates.
3. Use the helpers in `department.ts` (`entityFrom`, `signalFrom`, `latestBySubject`, `recommend`) so recommendation ids are stable per day and confidence stays explicit.
   Give each recommendation a dollar `impact` with `estimate` when its number can be worked out from the store's data and `ASSUMPTIONS`; leave it out when it can't.
4. Add it to `RETAIL_DEPARTMENTS` in `src/index.ts`.
5. Write tests in `packages/retail/test/departments.test.ts` for each rule: the case that fires, the case that doesn't, and its edges. Coverage must stay above the thresholds in `vitest.config.ts`.
6. Add a row to the table above.

## What each recommendation is worth

A recommendation can carry an `impact`: what acting on it is worth, in cents. Its `kind` says how the money comes back:

- `makes`: profit on new sales, after the cost of the goods. A sale price is never counted as if it were profit.
- `saves`: a cost cut, such as a year of carrying cost on stock that finally sells.
- `protects`: money owed or at risk that the action keeps, such as a balance collected at pickup.

Each has a likely amount and a low to high range, and a `basis` that says how it was worked out with the figures used, so an owner can check it. `estimate` works the figure out three times, with every planning figure in `ASSUMPTIONS` at its low, likely and high value. The store's own numbers win where it has them: an occasion reminder uses that customer's own average order once they have bought before.

The likely values in `ASSUMPTIONS` are the same as the defaults of the payback estimate on the website. They are starting points; as KaratOS learns how each business works, its own figures replace them.

A recommendation with no honest number carries no `impact`: compliance reminders, late purchase orders, stalled custom work, late or unclaimed repairs, and metal price falls. The pipeline drops an `impact` that doesn't add up (amounts out of order, not whole cents, or no basis) and keeps the recommendation. Postgres keeps it in `recommendations.impact`.

| Reasoner | Kind | Worked out as |
| --- | --- | --- |
| `inventory.aged-stock` | saves | Cost on hand times a year's carrying rate |
| `inventory.reorder` | makes | A month of sales at the last 60 days' pace, times margin |
| `inventory.stock-agreement` (one item) | protects | The pieces the counts disagree by, at the cost of the latest receipt, when one is known |
| `clienteling.upcoming-occasions` | makes | Occasion sale rate times average order times margin |
| `clienteling.lapsed-vip` | makes | Win-back rate times their average order times margin |
| `clienteling.missed-calls` | makes | Callers times close rate times average order times margin |
| `sales.high-return-rate` | saves | Returns so far times the cost of handling one |
| `finance.cash-deposits` | protects | Cash taken with no matching deposit |
| `finance.overdue-receivables` | protects | Past-due balance times the share follow-up collects |
| `finance.payout-match` (short, failed, unrecorded, missing) | protects | The shortfall, or the sales never paid out, in US dollars only |
| `appraisals.insurance-update` | makes | Update fee times the share who take one |
| `repairs.follow-up` (pickup) | protects | The repair estimate |
| `custom-orders.progress` (balance) | protects | The balance still due |
| `buying.memo-due` (unsold) | protects | The memo cost owed if it runs past due |
| `buying.watch-wanted` | makes | Dealer margin on the lowest US dollar ask |
| `metals.price-move` (rise) | makes | Added metal value of pieces with a weight |
| `metals.buy-margin` | saves | Paid above 85% of melt |
| `metals.refiner-assay` | protects | Short fine metal at the settlement's own rate |
| `metals.refiner-payable` | makes | The lot at a fair share of spot, less what it paid |
| `marketing.campaign-return` | makes or saves | One more run of a winner, or the loss of a loser not repeated |

## Matching payouts to sales

Finance reads the payment connectors' records without owning them, so a connector's record is never dead-lettered by these rules. The connectors write every processor in the same types:

| Event | What it is | Kept as |
| --- | --- | --- |
| `payout.updated` | A payout or settlement batch: what was paid, when, its status, and any sales, refunds and fees reported with it | `payout.record`, one per payout |
| `balance.transaction_recorded` | A line of a payout: a sale, refund, fee or adjustment (Stripe, Klarna, Aurora Payments) | `payout.line`, with what it adds to its payout |
| `payment.charge_updated`, `payment.refund_updated` | A charge or refund; Authorize.net's say which settlement batch paid them | `payout.line`, for a processor whose charges name their batch |

Each payout is matched to the lines that name it. Stripe's lines don't name a payout, so each goes to the first payout in its currency made on or after the day it came available. A payout with no lines is checked against the sales, refunds and fees it reports itself (Affirm, Aurora Payments, Authorize.net). `finance.payout-match` then raises:

- **Short:** a paid payout more than the larger of $1 and 0.5% under its sales less refunds and fees. A payout paid over is the processor's loss, not the store's.
- **Missing:** a payout that failed or was canceled; lines that name a payout with no record, once that payout is due (the connector may have dead-lettered it); and sales in no payout more than 30 days past their processor's schedule.
- **Late:** sales in no payout past their processor's schedule, and a payout still pending or open past when it normally lands. Money paid out late isn't lost, so these carry no dollar figure.

A processor's schedule is the days after a sale is captured (for Stripe, after it comes available) by which it normally pays: Stripe, Authorize.net and Aurora Payments 4, Affirm 7, Klarna 10, and 7 for any other. These are in `PAYOUT_SCHEDULE_DAYS`. Payouts and sales more than 90 days old are left alone. Each recommendation's id carries the payout, or the processor and currency, so a run on the same day raises the same one, and a record read twice, or a newer version of it, counts once.

What the records allow, and what they don't:

- Square, Afterpay, Clover and Sola Payments write charges but no payouts, so their sales aren't matched. A sale is only called late or missing for a processor and currency whose payouts KaratOS reads.
- Stripe lines carry no payout id, so Stripe matching assumes automatic payouts that sweep the whole available balance. Manual payouts, reserves or a negative balance can make a Stripe payout look short; its recommendations carry lower confidence. The first Stripe payout seen has no known start, so it isn't judged.
- Authorize.net reports no fees on a batch (they are billed monthly), so its batches are matched to charges less refunds. Klarna's totals carry holdbacks and debt, so a Klarna payout is only checked against its lines.
- Lines are matched to the processor's own charge and capture ids, with Klarna's order reference and the store's own reference kept on each line. A POS sale (`sale.completed`) carries no processor id, so a payout isn't tied to it directly.
- A payout isn't judged against lines in another currency, since there is no rate to convert them; a short payout in another currency is raised in its own money with no dollar figure.
- Like every rule, matching sees the most recent signals in the reasoning window. A payout whose record fell out of the window can make its lines look unrecorded until the next sync reads it again.

## Checking stock counts agree

Inventory reads every system's stock counts and checks that systems counting the same item agree. The connectors write them in two types:

| Event | Systems | Kept as |
| --- | --- | --- |
| `inventory.counted` | Katana, Acumatica JewelShop, Cin7 Core, NetSuite, Square, Clover, Lightspeed, BigCommerce, WooCommerce, Wix, Etsy, Squarespace, Whatnot, WatchTraderHub, and the POS export's stock file | `inventory.stock_level`, one per system, item and place counted (a location, or for Cin7 Core a location's bin and batch) |
| `product.updated` | Shopify, whose variants carry the quantity Shopify has across its locations | `inventory.stock_level`, one per variant, for a system that writes no counts of the item |

Items are matched by SKU, read without case, spaces, dashes (any kind) or underscores, so `rg-1001`, `RG 1001` and `RG_1001` are one item. A SKU a connector makes up for a record that has none (such as `shopify-variant-…` or `katana-variant-…`) is left out, since no other system knows it.

Each system's places are added up, so a total is compared with a total: Katana's two locations against Shopify's quantity, or Cin7 Core's bins against Acumatica's warehouses. Each system names its places in its own terms, so places aren't matched across systems. `inventory.stock-agreement` then raises an item when the systems' totals differ by more than 5% of the larger, rounded down, so any difference counts under 20 on hand. One recommendation names every system with its count and when it held. With three or more, when all but one agree, it names the one that is out. When five or more items, and half or more of those the same systems all count, disagree at once, they are raised once, for the systems, as that usually means they count different locations or one has stopped syncing. These figures are `STOCK_TOLERANCE_SHARE`, `STOCK_SYSTEMIC_MIN_ITEMS` and `STOCK_SYSTEMIC_SHARE`.

Counts are compared only when they held within 24 hours of each other (`STOCK_COMPARABLE_HOURS`), and are left alone once last known more than 7 days ago (`STOCK_LOOKBACK_DAYS`). When a count held depends on where it came from:

- A store system's count (any `inventory.counted` but the POS export's) holds from the time the system gives it until that system was last read, since these connectors read every count each pass and store one again when it changes.
- A row of the POS export holds on its own date only, since a later export may simply leave an item out.
- A Shopify quantity holds when it was read. Shopify doesn't change a product's update time when only its stock moves, so a product read again unchanged is a duplicate and its quantity grows older until the product changes.

A system whose places were counted more than 24 hours apart has no total for that item, and the systems compared are the latest ones that all held within 24 hours of each other. Each recommendation's id carries the item's SKU as matched, or the systems, so a run on the same day raises the same one, and a count read twice, or a newer count of the same place, counts once.

What the records allow, and what they don't:

- Gem Logic's products carry no quantity, and Amazon's counts are of stock in Amazon's own warehouses, which no other system counts, so neither is compared. An item only one system counts isn't raised.
- A system that counts only some of the store's locations, such as a website that sells only what is in the shop, will disagree with one that counts every location. That shows up as many items at once and is raised once for the two systems, not item by item.
- A system's last read is the latest count it stored. A system whose sync has stopped keeps its last counts, and when nothing changed in it for a day, its counts are no longer compared with a system read since.
- Places are added up from their latest count, so a location that stops reporting an item keeps its last count in that system's total.
- Like every rule, the check sees the most recent signals in the reasoning window, so in a large catalog the items compared are those counted most recently.

## Sending department events

Every department event uses the standard envelope (see [architecture](../architecture/overview.md)) with the department's payload. For example, a completed sale:

```json
{
  "id": "evt_sale_1001",
  "source": "pos",
  "type": "sale.completed",
  "occurredAt": "2026-10-01T15:30:00Z",
  "receivedAt": "2026-10-01T15:30:02Z",
  "idempotencyKey": "sale-1001",
  "payload": {
    "saleId": "1001",
    "customerId": "cust-42",
    "channel": "store",
    "lines": [{ "sku": "RING-14K-001", "quantity": 1, "unitPriceCents": 120000 }],
    "totalCents": 120000,
    "payments": [{ "method": "card", "amountCents": 120000 }]
  }
}
```

Post it to `POST /v1/events` on the instance; the instance fills in its own `organizationId`. The exact payload of every event is the zod schema in its department file.
