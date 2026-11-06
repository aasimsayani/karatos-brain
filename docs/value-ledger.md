# The value ledger

KaratOS's promise to a jeweler is simple: you pay us, and we show you, in dollars, what we put back. The value ledger is how it keeps that promise.

## Estimate, decision, result

1. **Estimate.** A recommendation can carry an `impact`: what acting on it is likely worth, with a range and how it was worked out. See [what each recommendation is worth](departments/README.md#what-each-recommendation-is-worth).
2. **Decision.** The owner accepts, dismisses or overrides it (`POST /v1/recommendations/:id/feedback`).
3. **Result.** What acting on it actually brought back is recorded as a `ValueResult` (`POST /v1/recommendations/:id/result`). Its `source` is `reported` when a person entered it and `measured` when KaratOS worked it out from the store's own data. A result of zero says it was done and brought nothing back.

A result keeps the kind of its estimate: money a recommendation said it would save is recorded as saved, not as profit.

## The report

`GET /v1/value?from=2026-10-01&to=2026-11-01` (or `readValueReport` in `@karatos/core`) follows every recommendation raised in the period through to the period's end:

| Line | What it counts |
| --- | --- |
| `shown` | Recommendations raised, how many carry an estimate, and their likely amounts by kind |
| `approved` | Accepted, by the latest word on each, with their likely amounts |
| `dismissed`, `overridden` | Turned down, or done differently |
| `returned` | Recommendations with a result, and the cents that came back by kind |
| `awaiting` | Approved with no result yet: what is still to come back |

Each recommendation counts once. The latest feedback decides whether it was approved, and the latest result decides what came back, so a result measured again at 60 or 90 days replaces the earlier one rather than adding to it. A result counts even without an Accept, since an owner may act without pressing the button. Anything recorded after the period's end waits for the next report.

Comparing `returned.cents.total` with what the owner pays for KaratOS gives the times-back figure the website's payback estimate promises.

## Storage

Postgres keeps results in `value_results`, one row per recording, under the same row-level security as every other table. Earlier results are kept when a later one replaces them in the report, so the history stays auditable.

## Measured results

An estimate can say how to read its own result from the store's data, with an `ImpactMeasure`: which kind of signal, on which subject, which field holds the cents, and what share of them is the business's gain. Once a recommendation is approved, KaratOS measures it at 30, 60 and 90 days, up to the measure's window, and records each as a `measured` result with its checkpoint (`measuredDays`). Each sums everything since the recommendation, so the 90-day result replaces the 30-day one in the report rather than adding to it. Postgres keeps one measured result per recommendation and checkpoint, so measuring twice can't double up.

Measuring runs with every reasoning run (`POST /v1/reason` returns how many results it recorded) and looks back over the last 91 days of recommendations.

Only approved recommendations are measured. A customer who would have come back anyway isn't counted for a reminder nobody acted on.

| Rule | Measured as | Window |
| --- | --- | --- |
| `clienteling.upcoming-occasions` | The margin on what that customer buys | 30 days |
| `clienteling.lapsed-vip` | The margin on what that customer buys | 90 days |
| `custom-orders.progress` (balance) | Payments on that order | 30 days |

Other rules are recorded by hand for now. Rules whose outcome lives in data KaratOS reads (an invoice paid, a memo returned, a piece sold) are next.
