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

## Next

Measuring results automatically: each rule will say how to read its own outcome from the store's data (did the lapsed customer buy within 90 days, did the past-due invoice get paid) and record it as `measured` at 30, 60 and 90 days.
