# Asking the instance

You can ask an instance a question in plain words, such as "what sold this week?" or "which payouts are late?". It answers only from the data it has synced. Every number in the answer names the events it was counted from and the systems that sent them. The instance never estimates a missing figure. If it has nothing for the question, it says so in words instead of showing zeros.

## What you can ask

| Ask about | For example | Answered from |
| --- | --- | --- |
| Sales | "What sold this week?", "How much did we make yesterday?", "Refunds last month" | `sale.completed` and `sale.returned` events dated in the period: sales, gross, refunds and net, by channel and by system. These are the same figures the [daily brief](daily-brief.md) counts |
| Payouts | "Which payouts are late?", "Did the Stripe deposit come in?" | Open findings of the `finance.payout-match` rule: payouts that are late, never paid out, paid short, still pending, failed or have no record |
| Stock | "What's low on stock?", "Do the inventory counts agree?" | Open findings of `inventory.reorder` (low on stock) and `inventory.stock-agreement` (counts that disagree between systems) |
| Customers waiting | "Who is waiting on a reply?", "Any missed calls?" | Open findings of `clienteling.awaiting-reply` and the missed-call rule |
| What's waiting on you | "What's waiting on me?", "Open recommendations" | Every open recommendation, highest dollar impact first |
| Sync health | "Is everything syncing?", "Which connectors failed?" | The sync runner's last result for each connector: failed, stale (more than 24 hours old), not run yet, or turned on but not syncing |
| How to do or find something | "How do I connect Shopify?", "Where is the UPS tracking numbers file set?" | [Documentation search](doc-search.md): the three passages of the docs and the integration catalog closest to the question, each naming the document, heading and version it came from |

A finding is open when nobody has accepted, rejected or overridden its latest raising in the last 14 days, as in the daily brief. Findings come from the latest reasoning run, so a finding can only be as recent as that run. The instance reasons on its own after each sync round that brings new events, before the daily brief and at least hourly (see [scheduled reasoning](deployment/instances.md#scheduled-reasoning)), and `POST /v1/reason` still runs it on demand. Answers about findings, and the sync health answer, end by saying when the findings were last refreshed, or that the last run failed, that none has run yet, or that scheduled reasoning is off. A `POST /v1/reason` call counts as a refresh like a scheduled run, and after a restart the last run in the database does.

Any other question gets "I can't answer that yet", with the list above.

## How a question is understood

The instance matches a question to one of the answers above by its words. No language model is involved: the repository has no model client, so none was added. The words are tried in this order, and the first match wins: sync, payouts, replies, stock, recommendations, sales. So "how are sales and payouts?" is answered as a payouts question. Ask about one thing at a time.

A question that starts "how do I", "how can we", "how to", "where is", "where do I", "which setting" or the like asks how to do or find something, so it is answered from the documentation, whatever else it mentions, unless it names a period: "how do I see what sold yesterday?" is still a sales question. The answer quotes the closest passages with their sources. When nothing in the docs is close, it says so and suggests naming the system or the setting; on an instance without documentation search it says that search isn't set up.

A sales question can name a period. Periods are whole days on the store's calendar, in `STORE_TIME_ZONE` (America/New_York by default):

| You write | It covers |
| --- | --- |
| `today` | Today so far. This is also the default when a sales question names no period, and the answer says so |
| `yesterday` | The day before today |
| `this week`, `week to date` | Monday through today. Weeks start on Monday |
| `last week`, `previous week` | The Monday through Sunday before this week |
| `last 7 days`, `past 30 days`, `past week` | That many days ending today, today included |
| `this month`, `last month` | The 1st through today, or the whole month before |
| `this year`, `ytd` | January 1 through today |
| `in October`, `for February 2024` | That whole month. With no year, a month still to come this year means last year's |
| `2026-11-18`, `November 18`, `18 Nov 2026` | That day. With no year, a day still to come this year means last year's |
| `2026-11-01 to 2026-11-15`, `between 2026-11-01 and 2026-11-03` | Both days and every day between |
| `since 2026-11-10` | That day through today |

The instance won't guess at a period it can't read. It answers with what was wrong in these cases:

- A day that isn't on the calendar, such as 2026-02-30.
- A range that runs backwards.
- A period that starts after today in the store's time zone.
- A period longer than 366 days.
- A date written like 11/12, which could be either November 12 or December 11. Write 2026-11-12 or November 12.

A period that runs past today is read up to today. A store day runs from local midnight to local midnight, so a day is 23 or 25 hours long when the clocks change, and a week across a change is 7 days and an hour more or less. A sale at 11:30 pm Eastern on the 18th is counted on the 18th, even though in UTC it happened on the 19th.

Payouts, stock, customers waiting, recommendations and sync health are answered as they stand now. If one of those questions names a period, the answer says the period didn't narrow it.

## Saying what it doesn't know

- **Nothing synced for the question.** If no event of the kind the question needs has ever synced, the answer is `no_data`. It says "Nothing has synced for that yet" and gives no figures. The kinds are sale events for sales; payout, balance, charge and refund events for payouts; stock counts, receipts and listings for stock; and messages and calls for customers waiting.
- **Nothing open, but data has synced.** For payouts, stock and customers waiting, the answer says nothing is open. It also names the latest record the rules could have used (its event id, system and time), so "none" is backed by a record.
- **A quiet period.** If sales synced before the period but none are dated in it, the answer says so and cites the latest earlier sale. If every sale the instance has comes after the period, the answer is `no_data` for that period.
- **Data it couldn't read.** If an event's raw payload was cleared by [retention](architecture/data-retention.md) or can't be read, it isn't counted. Its id is listed under `uncounted` and the answer says the figures are a floor. The same applies past 20,000 sale events in one period: only the first 20,000 are read.
- **A system it couldn't look up.** To cite a finding's systems, the instance looks up the events in the finding's provenance, at most 500 per answer. Any event it couldn't find is shown as "system unknown", and its id is still listed. A dollar figure whose events have no known system isn't stated as a cited fact.
- **Sync results unknown.** If the instance has no sync results, the sync answer says it can't tell rather than reporting that nothing failed.

## Asking

`POST /v1/ask` with `{ "question": "what sold this week?" }`, or `GET /v1/ask?q=what+sold+this+week`. Both need the instance API key. The support key gets 403, because answers contain business data. The route only reads: it doesn't run reasoning or save anything.

```
curl -s https://<instance>/v1/ask \
  -H "authorization: Bearer $KARATOS_API_KEY" \
  -H "content-type: application/json" \
  -d '{"question":"which payouts are late?"}'
```

A question is trimmed and must be 1 to 500 characters. An empty, missing or too long question, a body that isn't JSON, or a body that isn't an object with a string `question` gets 400 with the reason. A body over 8 KB gets 413. Any question that passes those checks gets 200, including one the instance can't answer.

The response is `{ "answer": { ... } }`. The answer has these fields:

- `question`, `intent` (`sales`, `payouts`, `stock`, `awaiting_reply`, `open_recommendations`, `sync_health`, or null), `timeZone` and `generatedAt`.
- `status`: `answered`, `no_data`, `unsupported` or `unclear_period`.
- `text`: the answer in words. Each number is followed by its citation in brackets, with the first three event ids and a count of the rest. The JSON always has every id.
- `facts`: every number the answer states, each as `{ label, value, unit: "count" | "cents", citation: { eventIds, systems } }`. A zero is never listed as a fact. For sales, the facts are the totals and each channel's and system's figures. For findings, they are how many are open, citing every finding's events, and each listed finding's dollar impact.
- `period`, when there is one: `{ label, fromDay, toDay, from, to, days, defaulted }`, where `from` and `to` are the UTC instants the store days cover.
- `sales`, for a sales question: `totals`, `byChannel`, `bySystem`, `uncounted` and `truncated`, in the same shape as a day in the daily brief.
- `findings` and `moreFindings`. Each finding is `{ recommendationId, rule?, kind?, summary, confidence, impact?, createdAt, eventIds, signalIds, systems, degraded }`. `kind` says which kind of finding it is within the answer: `late`, `missing`, `short`, `pending`, `failed` or `unrecorded` for payouts; `low` or `disagree` for stock; `awaiting_reply` or `missed_calls` for customers. At most 10 are listed, and `moreFindings` counts the rest.
- `sync`, for a sync question, in the same shape as the daily brief's.
- `reasoning`, for findings and sync questions when the instance reports it: when the findings were last refreshed, in the same shape as the daily brief's `sync.reasoning`.
- `notes`: anything that qualifies the answer, such as figures being a floor.
- `canAnswer`, for an unsupported question: the list of what can be asked.

## Code

- [`packages/retail/src/ask.ts`](../packages/retail/src/ask.ts) holds `routeQuestion`, which matches a question's words and reads its period, and `answerQuestion`, which turns what the server read into the answer. Both are pure. They reuse the daily brief's sales counting, open-finding and sync helpers and its store-day functions.
- [`packages/server/src/ask.ts`](../packages/server/src/ask.ts) holds `readAnswer`. It reads only what a question needs: the period's sale events through `eventsBetween`, the latest relevant event through `latestEventBefore`, the last 14 days of recommendations and their feedback, and each cited event's system through `getEvent`.
- The route is in [`packages/server/src/app.ts`](../packages/server/src/app.ts). It uses the same time zone, clock and sync results as `GET /v1/brief`.
