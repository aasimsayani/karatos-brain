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
| `inventory` | Inventory and Merchandising | `inventory.received`, `inventory.adjusted`, `inventory.counted` | Pieces unsold for 270 days, with their gold melt value; reorders when 1 or fewer are left and 2 or more sold in 60 days |
| `clienteling` | Clienteling and CRM | `customer.profile_updated`, `customer.occasion_recorded`, `wishlist.item_added` | Birthdays and anniversaries within 21 days (only for customers who consented to marketing), with their wish list; VIPs with $5,000+ lifetime spend and no purchase in a year |
| `repairs` | Repairs and Service | `repair.received`, `repair.status_changed` | Repairs past their promised date; pickup reminders after 30 days ready; a final-notice review after 180 days |
| `custom_orders` | Custom and Special Orders | `custom_order.created`, `custom_order.stage_changed`, `custom_order.payment_received` | Orders stuck 14 days in one stage; orders due within 7 days (or overdue) that haven't reached finishing; balances due when ready |
| `appraisals` | Appraisals | `appraisal.completed` | Insurance appraisals more than 3 years old |
| `buying` | Buying, Vendors and Memo | `memo.received`, `memo.settled`, `purchase_order.created`, `purchase_order.received` | Memo goods due back within 14 days (pay if sold, return if not); late purchase orders |
| `metals` | Metals and Gold Buying | `metal.price_updated`, `gold_purchase.completed` | Spot moves of 5% or more, with the pieces affected; gold bought at more than 85% of melt |
| `marketing` | Marketing | `campaign.sent`, `campaign.sale_attributed` | After 14 days, campaigns returning 3x or more (repeat them) or less than 1x (rethink them) |
| `finance` | Finance | `bank.transaction_imported`, `bank.account_updated`, `accounting.invoice_updated`, `accounting.record_deleted` | Cash sales over 30 days that are more than 5% (and $200) above cash deposits; $500 or more in US dollar invoices more than 30 days past due. Keeps each bank account's balance (`bank.balance`) and each invoice with what is still owed (`receivable.invoice`, or `receivable.removed` once deleted) as signals for the console |
| `compliance` | Compliance | none, it reads other departments | IRS Form 8300 for cash over $10,000 in 24 hours, with the 15-day deadline; possible structuring across 30 days; gold bought from the public without seller ID |

Compliance recommendations are reminders for the owner, not legal advice. State rules for secondhand dealers and unclaimed property differ, so those recommendations say to follow the state's rules rather than naming a period.

## How departments feed each other

These links already exist, and each one makes both departments more useful than they'd be alone:

- **Sales → inventory:** sell-through drives aged-stock and reorder recommendations.
- **Sales → clienteling:** lifetime value finds lapsed VIPs.
- **Sales → compliance and finance:** cash payments drive Form 8300, structuring and deposit checks.
- **Metals → inventory:** spot prices value aged gold pieces at melt.
- **Metals → gold buying:** spot prices check what was paid for gold bought from the public.
- **Clienteling → sales:** wish lists appear in occasion reminders.

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
| `clienteling.upcoming-occasions` | makes | Occasion sale rate times average order times margin |
| `clienteling.lapsed-vip` | makes | Win-back rate times their average order times margin |
| `clienteling.missed-calls` | makes | Callers times close rate times average order times margin |
| `sales.high-return-rate` | saves | Returns so far times the cost of handling one |
| `finance.cash-deposits` | protects | Cash taken with no matching deposit |
| `finance.overdue-receivables` | protects | Past-due balance times the share follow-up collects |
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
