# The daily brief

Each morning an instance builds a short summary of the store's previous day from the data it has synced. The brief covers three things:

1. **Yesterday's sales.** It gives the number of sales, gross, refunds and net, by channel and by system, next to the same weekday a week earlier.
2. **Anything unusual.** These are open findings of the payout, stock-count, waiting-customer and return-rate rules, plus any connector that failed, went stale, hasn't run or isn't syncing.
3. **Recommendations waiting on you.** These are the other open recommendations, with the highest dollar impact first.

The brief only reports what was synced. It never estimates a missing figure. When the instance has no data, the brief says so in words and shows no zeros.

## Where it comes from

| Part | Read from | Cited by |
| --- | --- | --- |
| Sales | `sale.completed` events (each one's `totalCents` and `channel`) and `sale.returned` events (the sum of each line's `refundCents`), dated by when they happened (`occurredAt`) | Every figure carries the ids of the events it was counted from and the systems (event sources) that sent them. Sales and refunds are cited separately |
| Same day last week | The same events, for the store day 7 days earlier | The same citations |
| Unusual | Open recommendations from `finance.payout-match`, `inventory.stock-agreement`, `clienteling.awaiting-reply` and `sales.high-return-rate`, plus the sync runner's last result for each connector | Each finding carries its recommendation id, the rule that raised it, and the event and signal ids in its provenance. Each sync problem names its system and, for a failure, the scrubbed error |
| Waiting on you | Every other recommendation raised in the 14 days before the morning after the day that nobody has accepted, rejected or overridden | The recommendation id and its provenance |

Connector events don't carry a channel on returns, so in the channel breakdown refunds are listed under `returns`. The system breakdown shows which system each refund came from.

A finding that is raised again each day is listed once, by its latest raising. If someone has answered that latest raising, the finding is left out. The rules the brief treats as unusual are listed in `BRIEF_UNUSUAL_RULES` in [`packages/retail/src/brief.ts`](../packages/retail/src/brief.ts). A rule is known by the prefix of the recommendation ids it raises.

A connector is called stale when its last finished sync is more than 24 hours old. Sync results are kept in memory, so a connector that hasn't finished a sync since the instance last started is reported as not run yet.

## Saying what it doesn't know

- **No sales ever synced.** The sales section says no sales have synced and shows no figures. If nothing else has synced either (no recommendations and no successful sync), the whole brief says the instance has no synced data. It still lists any connector that failed or is missing its settings, because that is usually why.
- **A quiet day.** If sales have synced before, a day with none shows "no sales; no refunds". The brief also cites the latest earlier sale (its event id, system and time), so the zero is backed by the record that shows sales were syncing.
- **Data it couldn't read.** If an event's raw payload was cleared by [retention](architecture/data-retention.md) or can't be read, it isn't counted. Its id is listed under `uncounted`, and that day's figures are marked `partial`. The same applies to a day with more than 10,000 sale events: only the first 10,000 are read.
- **Sync results unknown.** If the brief is built without sync results, it says so instead of reporting that no connector had a problem.

## Days and time zones

A store day runs from local midnight to local midnight in `STORE_TIME_ZONE` (America/New_York by default). A sale at 11:30 pm Eastern on the 18th is counted on the 18th, even though in UTC it happened on the 19th. On the day the clocks go forward the store day is 23 hours long, and on the day they go back it is 25. The comparison day is the same weekday a week earlier, counted on the store's calendar, so a comparison across a clock change still covers whole store days.

## When it is built

The instance builds yesterday's brief once a day at `BRIEF_HOUR` on the store's clock (7 by default).

- **On a schedule.** When the instance starts, it checks right away. After that it sleeps until the next `BRIEF_HOUR`, worked out on the store's clock, so the hour is still 7:00 after a clock change. If the hour falls in the skipped hour on the day the clocks go forward, the brief is built when the clocks jump.
- **Saved once.** Each brief is saved in the `daily_briefs` table, one row per organization and day. If a brief is already saved for that day, nothing is built or sent. So when the instance restarts after the hour, the day's brief is not built or delivered again, and when it restarts before the hour, it waits for the hour. If two instances race, the database keeps only one brief for the day, and only the one that saved it delivers it.
- **Fresh findings first.** Just before it builds a due brief, the instance runs the department rules, unless a run finished in the last 10 minutes or one is in progress, which it waits for. A failed run doesn't stop the brief; the brief says when its findings were last refreshed instead. See [scheduled reasoning](deployment/instances.md#scheduled-reasoning). With `REASON_SCHEDULE=off` the brief is built from the findings as they are.
- **Retried on failure.** If a build fails, nothing is saved and it is tried again 15 minutes later.
- **Not built late.** A morning missed while the instance was down is not built afterwards. `GET /v1/brief?date=` can still read that day.
- **Logged as counts.** The log line lists counts only, such as `brief 2026-11-18 built: 12 sales, 1 refunds, 2 unusual, 0 sync problems, 5 waiting`. The brief's text, which names customers' spending and recommendation details, goes only into the database and to the webhook.

## Reading it

`GET /v1/brief?date=YYYY-MM-DD` needs the instance API key. The support key gets 403, because the brief contains business data. With no `date`, it returns yesterday on the store's calendar. It works out the brief from current data each time. Today is allowed and covers the day so far. A day after today in the store's time zone is refused with 400. The route only reads: it doesn't run reasoning, save a brief or send one.

The response is `{ "brief": { ... } }`. The brief has these fields:

- `date`, `timeZone`, `generatedAt` and `hasData`.
- `sales`. Either `{ status: "no_data", note }`, or `{ status: "ok" | "partial", day, lastWeek, change, lastSaleBefore?, notes }`. Each day has `from` and `to` (the UTC instants it covers), `totals`, `byChannel`, `bySystem`, `uncounted` and `truncated`. Each figure set has `sales`, `grossCents`, `refunds`, `refundCents` and `netCents`, with `saleEvents` and `refundEvents` as `{ eventIds, systems }`.
- `unusual` and `waiting`. Each is a list of `{ recommendationId, rule?, summary, confidence, impact?, createdAt, eventIds, signalIds, degraded }`, highest impact first. The order is by `impact.cents`, then confidence, then newest. `waiting` lists at most 10, and `moreWaiting` counts the rest.
- `sync`. Either `{ known: false, note }`, or `{ known: true, checkedAt, problems, healthy, reasoning? }`. Each problem is `{ system, problem: "failed" | "stale" | "not_run" | "not_syncing", detail, at? }`. `reasoning` says when reasoning last refreshed the findings: `{ status, detail, refreshedAt }`, where `status` is `fresh`, `stale` (more than 24 hours ago), `failed` (the last run failed), `not_run` (none on record) or `off` (`REASON_SCHEDULE=off`). Scheduled runs and `POST /v1/reason` calls both count, and after a restart the last run in the database does (see [scheduled reasoning](deployment/instances.md#scheduled-reasoning)). The plain text ends with its `detail`, such as "Findings were last refreshed at 2026-11-19T11:58:02.000Z."
- `text`. The same brief as plain text. Each figure is followed by its citation in brackets, with the first three event ids and a count of the rest; the JSON always has every id.

To ask for these figures for another period, or for one part of the brief, in plain words, see [asking the instance](ask.md).

## Sending it on

The brief can be posted to one address an operator sets up. Delivery is off by default. Set `BRIEF_WEBHOOK_URL` to an https address, such as a chat tool's incoming webhook, and each newly built brief is posted there once:

```
POST <BRIEF_WEBHOOK_URL>
content-type: application/json

{ "type": "karatos.daily_brief", "brief": { ... } }
```

Delivery is not retried. It times out after 10 seconds and doesn't follow redirects. A failure is logged with the HTTP status only, never the address. `BRIEF_WEBHOOK_URL` is a **secret**, because such addresses usually carry a token: keep it in the host's secret store (see [secrets](secrets.md)). Remove it to stop sending. The brief is never emailed or texted.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `STORE_TIME_ZONE` | `America/New_York` | The store's IANA time zone. Store days and `BRIEF_HOUR` follow its clock |
| `BRIEF_HOUR` | `7` | The local hour, 0 to 23, from which yesterday's brief is built |
| `BRIEF_WEBHOOK_URL` | unset | Optional https address the brief is posted to. Secret |

## Code

- [`packages/retail/src/brief.ts`](../packages/retail/src/brief.ts) holds `buildDailyBrief`, a pure function from events, recommendations, feedback and sync results to the brief. It also holds the store-day and time-zone helpers.
- [`packages/server/src/brief.ts`](../packages/server/src/brief.ts) holds `readDailyBrief`, which reads those inputs from the store; the morning scheduler, `createBriefRunner`; and `webhookDelivery`.
- The store reads events through `MemoryStore.eventsBetween` and `latestEventBefore`. Both use the existing `(organization_id, type, occurred_at)` index. Briefs are saved through `BriefStore` in the `daily_briefs` table.
