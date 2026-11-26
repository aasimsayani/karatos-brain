# The feedback loop

What a store does with KaratOS's recommendations changes what it recommends next. Every reasoning run reads the store's own history (recommendations, the owner's accept, dismiss and override decisions, and the [value ledger](value-ledger.md)) and uses it two ways. Nothing is kept in the process, so a restart changes nothing, on Postgres or in memory.

## Dismissed recommendations wait out a cooldown

When the owner dismisses a recommendation, the same rule and subject isn't raised again for `FEEDBACK_COOLDOWN_DAYS` (default 14, allowed 0 to 90; 0 turns the cooldown off), counted from the dismissal.

- **Same rule and subject** means the same recommendation id without its trailing day: `rec_clienteling_lapsed_c1_2026-11-20` and `rec_clienteling_lapsed_c1_2026-11-26` are the same lapsed customer. A different customer, order or SKU from the same rule is a different subject and isn't held back.
- **The latest decision counts.** If the subject was accepted or overridden after the dismissal, or the owner changed their mind on the dismissed one, the cooldown ends.
- **It comes back early when it grew materially:** its dollar estimate is at least a quarter more than the dismissed one's, it carries an estimate where the dismissed one had none, or the rule's confidence in it rose by 0.1 or more (compared with what the rule wrote, before feedback). Its note then says so, such as "Shown again though it was dismissed on 2026-11-21: its estimate grew from $100.00 to $125.00."
- **Held back means not shown.** It isn't stored or returned. `POST /v1/reason` lists each one under `heldBack` as `{ id, rule, dismissedAt, until }`.

## Rules are ranked by how the store treated them

Over the last 180 days, by the latest word on each recommendation:

| What happened | Effect on the rule's confidence |
| --- | --- |
| Fewer than 3 decisions (accepts, dismissals and overrides) | None yet |
| Half or fewer dismissed | None |
| More than half dismissed | Lowered in a straight line, to 0.6 times when every one was dismissed (three in four dismissed is 0.8 times) |
| Accepted recommendations brought money back (the latest result on each, measured at 30, 60 or 90 days or reported) | 1.1 times |
| ...at least as much as their estimates said | 1.2 times |

The two multiply, so a mostly dismissed rule whose accepted recommendations paid off lands in between. Confidence stays between 0 and 1. A run's recommendations are then ordered by that factor, highest first; ties, which include every recommendation when there is no history yet, keep the order the rules gave them. Overrides count as decisions but not as dismissals, and a result on a recommendation nobody accepted doesn't raise its rule.

Each recommendation carries why, under `ranking`:

```json
{
  "rule": "clienteling.lapsed-vip",
  "confidence": 0.52,
  "ranking": {
    "baseConfidence": 0.65,
    "factor": 0.8,
    "note": "3 of 4 decisions on this rule in the last 180 days were dismissals, so it ranks lower."
  }
}
```

`rule` is the reasoner that raised it. Recommendations stored before rules were recorded have no `rule`: they still start a cooldown for their subject but don't count toward any rule's ranking.

## The summary per rule

`GET /v1/feedback` (instance API key) shows what the next run will go by:

```json
{
  "feedback": {
    "organizationId": "example-jewelers",
    "asOf": "2026-11-26T12:00:00.000Z",
    "cooldownDays": 14,
    "lookbackDays": 180,
    "on": true,
    "rules": [
      {
        "rule": "clienteling.lapsed-vip",
        "shown": 6,
        "accepted": 1,
        "dismissed": 3,
        "overridden": 0,
        "returned": { "count": 1, "cents": 0, "estimatedCents": 0 },
        "coolingDown": 2,
        "factor": 0.8,
        "note": "3 of 4 decisions on this rule in the last 180 days were dismissals, so it ranks lower. 1 accepted recommendation brought nothing back yet."
      }
    ]
  }
}
```

`coolingDown` is how many of the rule's subjects are held back right now. It isn't on support status, since rule-by-rule decisions and dollars are business data.

## In code

`applyFeedback` and `ruleFeedback` in `@karatos/core` are pure functions over a history; `readFeedbackHistory` and `readFeedbackSummary` read one from any `MemoryStore`. `BrainPipeline` runs the loop on every `reason` call (`reasonWithFeedback` also returns what was held back). Its `feedback` option takes a partial `FeedbackPolicy` (cooldown, lookback, decisions needed, growth share and confidence growth) or `false` to turn the loop off, which leaves recommendations as the rules wrote them apart from recording their rule. Postgres keeps `rule` and `ranking` in two columns on `recommendations` (migration `20261126000001_recommendation_feedback.sql`).
