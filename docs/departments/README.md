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
| `inventory` | Inventory and Merchandising | `inventory.received`, `inventory.adjusted` | Pieces unsold for 270 days, with their gold melt value; reorders when 1 or fewer are left and 2 or more sold in 60 days |
| `clienteling` | Clienteling and CRM | `customer.profile_updated`, `customer.occasion_recorded`, `wishlist.item_added` | Birthdays and anniversaries within 21 days (only for customers who consented to marketing), with their wish list; VIPs with $5,000+ lifetime spend and no purchase in a year |
| `repairs` | Repairs and Service | `repair.received`, `repair.status_changed` | Repairs past their promised date; pickup reminders after 30 days ready; a final-notice review after 180 days |
| `custom_orders` | Custom and Special Orders | `custom_order.created`, `custom_order.stage_changed`, `custom_order.payment_received` | Orders stuck 14 days in one stage; orders due within 7 days (or overdue) that haven't reached finishing; balances due when ready |
| `appraisals` | Appraisals | `appraisal.completed` | Insurance appraisals more than 3 years old |
| `buying` | Buying, Vendors and Memo | `memo.received`, `memo.settled`, `purchase_order.created`, `purchase_order.received` | Memo goods due back within 14 days (pay if sold, return if not); late purchase orders |
| `metals` | Metals and Gold Buying | `metal.price_updated`, `gold_purchase.completed` | Spot moves of 5% or more, with the pieces affected; gold bought at more than 85% of melt |
| `marketing` | Marketing | `campaign.sent`, `campaign.sale_attributed` | After 14 days, campaigns returning 3x or more (repeat them) or less than 1x (rethink them) |
| `finance` | Finance | `bank.transaction_imported` | Cash sales over 30 days that are more than 5% (and $200) above cash deposits |
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
4. Add it to `RETAIL_DEPARTMENTS` in `src/index.ts`.
5. Write tests in `packages/retail/test/departments.test.ts` for each rule: the case that fires, the case that doesn't, and its edges. Coverage must stay above the thresholds in `vitest.config.ts`.
6. Add a row to the table above.

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
