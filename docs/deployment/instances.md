# One instance per client

Brain A is open source, but every client's data lives in a deployment of its own. Fuse Jewelry is the first client and gets the first instance.

## What an instance is

| Piece | One per client | Why |
| --- | --- | --- |
| Supabase project | Yes | Separate database, backups, keys and bills. One client's breach or mistake can't reach another. |
| Running container | Yes | The `karatos-brain` image, started with that client's settings. |
| `ORGANIZATION_ID` | Yes | Stamped on every row. The API refuses events for any other organization. |
| `INSTANCE_API_KEY` | Yes | Only that client's agents and connectors can call the instance. |
| `SUPPORT_API_KEY` | Optional | Whoever supports the instance can check its health, setup and syncs without seeing the business's data. See [support access](../security.md#support-access-without-seeing-data). |
| Private instance repo | Yes | Holds the client's deploy settings and custom modules. Never holds secret values. |
| Code | Shared | Every instance runs the same public image, so a fix ships to everyone. |

Isolation is layered. A request needs the right API key. Every event is pinned to the instance's organization, and Postgres row-level security filters every table by organization. On top of that, each client has a physically separate database.

```
                    public repo: aasimsayani/karatos-brain
                    └── image: ghcr.io/aasimsayani/karatos-brain
                                 │
             ┌───────────────────┴───────────────────┐
             ▼                                       ▼
  Fuse Jewelry instance                    Next client's instance
  ├── private repo: fuse-jewelry-brain     ├── private repo: <client>-brain
  ├── container  (ORGANIZATION_ID=fuse-jewelry)    ├── container
  ├── Supabase project: fuse-jewelry-brain ├── Supabase project
  └── secrets in the host's secret store   └── secrets in the host's secret store
```

## Setting up a new client

1. **Create the client's Supabase project.** Name it `<client>-brain` and save the database password in your password manager.
2. **Create a private repo** from [`deploy/instance-template`](../../deploy/instance-template), named `<client>-brain`.
3. **Collect the settings.** In a checkout of this repo, run:
   ```bash
   cp .env.example .env.local
   npm run secrets:setup
   ```
   The tool generates the keys it can (API key, webhook secret) and walks you through the rest one at a time, with where to find each value. See [secrets](../secrets.md).
4. **Create the tables:** `npm run db:migrate`. The instance also does this on start when `MIGRATE_ON_START=true`.
5. **Deploy the image** to your host with the same settings in its secret store, and check `GET /healthz`. The log names any listed integration it can't sync yet and what it is missing; see [syncing on a schedule](../integrations.md#syncing-on-a-schedule).
6. **Hand out the API key** only to that client's agents and connectors.
7. **Set up support access, if the client wants it.** Generate a support key with `npm run secrets:setup -- --generate-only --purposes core,instance,migrations,support`, put `SUPPORT_API_KEY` in the host's secret store and restart. Give that key, never `INSTANCE_API_KEY`, to whoever supports the instance; it reaches only `GET /healthz`, `GET /v1/integrations` and `GET /v1/support/status`. For a client who wants their data kept from you, the client creates and owns the Supabase project and the host account in steps 1 and 5, and shares only the support key: anyone with database or host access can still read everything.

## Monitoring instances

Run the [instance monitor](../monitoring.md) from a private ops repo to hear when an instance stops answering, a connector fails or falls behind, dead letters pile up, migrations are missing or scheduled reasoning keeps failing. It uses only each instance's support key, so it never sees business data, and it can keep one GitHub issue per instance in the ops repo, closing it when the instance is healthy again.

## Verifying synced numbers

Once a client's systems are connected and their history has imported, run `npm run verify-sync` against the instance to show that its numbers match the source systems' own. For a period of store days, it compares Shopify and Square sale counts and gross, Stripe charges, refunds from all three and Klaviyo's new profiles with what synced, and lists the ids of any record on one side only. It needs the instance API key, because the ids are business records, and it makes no writes. See [verifying synced numbers](../verify-sync.md).

## Scheduled reasoning

The department rules (payout matching, stock agreement, customers awaiting a reply, return rates and the rest) run on their own, so the findings in the [daily brief](../daily-brief.md) and in [answers](../ask.md) stay fresh without anyone calling `POST /v1/reason`. Each run does what that route does: it reasons over recent signals, then records the results now due on approved recommendations.

- **After a sync round that brought new events.** A round where every connector found nothing new, or failed, doesn't start a run.
- **Before the daily brief.** The brief runner reasons first, so the 7:00 brief has fresh findings. If a run is in progress, the brief waits for it (and for one queued after it). If a run succeeded in the last 10 minutes, the brief uses it instead of reasoning again.
- **At least every `REASON_INTERVAL_MINUTES`** (default 60, allowed 5 to 1440) otherwise. The interval counts from the end of the last run, whatever started it. The first run comes after the first sync round that brings events, the first brief, or one interval, whichever comes first.
- **Never two at once.** A trigger while a run is in progress queues one more run after it. Every later trigger joins that queued run, so a burst of triggers costs one extra run at most.
- **Failures are retried at the next trigger.** A failed run is logged with its error's class name and how many runs have failed in a row, such as `reasoning (sync) failed: TypeError, 2 failed in a row; tried again at the next trigger`. A run that succeeds logs its counts only, such as `reasoning (interval): 12 recommendations, 1 results measured`. Neither line has recommendation text or an error message.
- **Stopped on shutdown.** On `SIGTERM` the interval is cleared, a queued run is dropped, and the instance waits for a run in progress to finish.
- **Reported on support status.** `GET /v1/support/status` has `reasoning`: `{ scheduled, intervalMinutes, lastRun, lastSucceededAt, consecutiveFailures }`. `lastRun` is `{ trigger: "sync" | "interval" | "brief", outcome, startedAt, finishedAt, recommendations, measured, error }`, where `error` is the class name only. It holds times and counts, never business data.

Set `REASON_SCHEDULE=off` to turn it off. Findings then refresh only when something calls `POST /v1/reason`, and the brief and answers say so. `POST /v1/reason` works as before either way. Its runs aren't counted on support status or in "findings were last refreshed".

| Setting | Default | What it does |
| --- | --- | --- |
| `REASON_SCHEDULE` | `on` | `on` or `off`. Off leaves reasoning to `POST /v1/reason` |
| `REASON_INTERVAL_MINUTES` | `60` | Longest gap, 5 to 1440 minutes, between the end of one scheduled run and the start of the next |

## Calling an instance

```bash
curl -X POST https://<instance-host>/v1/events \
  -H "Authorization: Bearer $INSTANCE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"id":"evt_1","source":"manual","type":"order.created",
       "occurredAt":"2026-10-01T12:00:00Z","receivedAt":"2026-10-01T12:00:01Z",
       "idempotencyKey":"order-1001","payload":{"orderId":"1001"}}'
```

The support key gets 403 on every endpoint below except `/healthz`, `GET /v1/integrations` and `GET /v1/support/status`.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | None | Liveness check |
| `POST /v1/events` | API key | Ingest one event. Returns 202, or 200 for a replay with the same idempotency key, or 403 if the event names another organization |
| `POST /v1/reason` | API key | Run the reasoners and return recommendations. The instance also runs them on its own; see [scheduled reasoning](#scheduled-reasoning) |
| `GET /v1/recommendations` | API key | Latest recommendations, with provenance and the degraded flag (`?limit=`, up to 200) |
| `POST /v1/recommendations/:id/feedback` | API key | Record `accepted`, `rejected` or `overridden`, with the actor and an optional note |
| `POST /v1/recommendations/:id/result` | API key | Record what acting on it brought back: `cents` (whole, zero or more), the actor and an optional note. The kind comes from its estimate; one with no estimate needs `kind` (`makes`, `saves` or `protects`) |
| `GET /v1/value` | API key | The value ledger for the recommendations raised in a period: shown, approved, dismissed, overridden, returned and still to come, in cents by kind (`?from=2026-10-01&to=2026-11-01`, up to 366 days; this month by default). See [the value ledger](../value-ledger.md) |
| `GET /v1/brief` | API key | The daily brief for a store day (`?date=2026-11-18`; yesterday in `STORE_TIME_ZONE` by default, up to today): sales, refunds and net by channel and system against the same weekday last week, open payout, stock, reply and return findings, sync problems, and the other open recommendations by impact, every figure citing its event ids and systems. Read-only. See [the daily brief](../daily-brief.md) |
| `POST /v1/ask`, `GET /v1/ask?q=` | API key | Answer a plain-language question (`{"question": "..."}` or `?q=`, 1 to 500 characters) about sales for a period, late or short payouts, low or disagreeing stock, customers waiting on a reply, open recommendations or sync health, from synced data only, every number citing its event ids and systems. A question it can't answer gets "I can't answer that yet" with what it can. Read-only. See [asking the instance](../ask.md) |
| `POST /v1/verify` | API key | Compare what has synced with each source system's own totals for whole store days (`{"from": "2026-11-01", "to": "2026-11-15"}`, both included, up to 92 days; optional `system` and `toleranceCents`): match, mismatch or unavailable for each metric, with source and synced totals, the difference and up to 20 ids missing or extra. Read-only, one run at a time (429 while one runs). `npm run verify-sync` calls it. See [verifying synced numbers](../verify-sync.md) |
| `GET /v1/entities/:kind/:id` | API key | One canonical entity |
| `GET /v1/signals` | API key | The latest signals, oldest first (`?kind=` up to 10 comma-separated kinds such as `bank.balance,receivable.invoice`; `?limit=`, 200 by default, up to 1,000). The console reads cash position and receivables this way |
| `GET /v1/integrations` | API key or support key | Every catalog integration and whether this instance has all its settings (`configured`, `missingSettings`). Names settings, never their values |
| `GET /v1/support/status` | API key or support key | Operational metadata only: instance name, organization id, version, uptime, applied migrations, retention days, enabled departments and integrations, each integration's missing setting names and last sync (times, mode, outcome, counts, scrubbed last error), scheduled reasoning's last run (times, trigger, outcome, counts, error class name), dead-letter counts by source and reason, and event counts by day, source and type (`?days=`, 14 by default, up to 90). Never payloads, ids, names, amounts, recommendation text or signal values |

## Choosing a host

The image runs anywhere that runs Docker containers. Pick the host once, and use it for every client so the runbook stays the same. Railway, Fly.io and Google Cloud Run all work: each gives a secret store, HTTPS and health checks.
