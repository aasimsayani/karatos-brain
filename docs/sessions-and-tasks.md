# Reasoning sessions and agent tasks

A **reasoning session** keeps the work around one question together, such as "why did repairs slow down?": notes, links to the recommendations and evidence it touched, and the tasks run for it. An **agent task** is one read-only operation that an outside agent, or the Brain Console, queues for a session, claims, reports progress on and finishes. Both live in the instance's own database, so work picks up where it left off after a restart.

Every route needs the instance API key. The support key gets 403 on all of them, as on every route that isn't diagnostic (see [support access](security.md#support-access-without-seeing-data)). Every instance keeps them in Postgres; an app built without a work store answers 503 on these routes.

## Sessions

| Route | What it does |
| --- | --- |
| `POST /v1/sessions` | Opens a session: `{ "subject", "actor", "note"?, "idempotencyKey"? }`. 201 when made, 200 with `duplicate: true` when the key was used before for the same request, 409 when it was used for a different one |
| `GET /v1/sessions?status=open\|closed&limit=` | Sessions, most recently changed first (50 by default, at most 200) |
| `GET /v1/sessions/:id` | The session with its tasks (newest first) and its audit trail (oldest first) |
| `POST /v1/sessions/:id/notes` | Adds a note: `{ "actor", "text" }`, up to 2,000 characters. A session keeps at most 200 notes |
| `POST /v1/sessions/:id/links` | Links what it touched: `{ "actor", "links": [{ "kind", "id", "entityKind"?, "note"? }] }`, up to 50 at a time and 500 in all. Each thing is linked once; linking it again changes nothing |
| `POST /v1/sessions/:id/close` | Closes it, with an optional closing `note`. Its queued and claimed tasks are cancelled; a running one finishes |
| `POST /v1/sessions/:id/reopen` | Opens a closed session again |

A link's `kind` is `recommendation`, `event`, `entity` (with `entityKind`, such as `customer`), `signal` or `reasoning_run`. Recommendations, events and entities must exist in the instance, or the link is turned down with 400. Signals and reasoning runs are taken by id as given, since the store has no lookup by id for them. A closed session takes no notes, links or tasks until it is reopened (409).

## Tasks

| Route | What it does |
| --- | --- |
| `GET /v1/tasks/kinds` | The kinds this instance allows, each with the operation it runs |
| `POST /v1/tasks` | Queues a task for an open session: `{ "sessionId", "kind", "input"?, "actor", "idempotencyKey"? }`. Idempotent like sessions |
| `GET /v1/tasks?sessionId=&status=&limit=` | Tasks, newest first |
| `GET /v1/tasks/:id` | The task and its audit trail |
| `POST /v1/tasks/claim` | Claims the oldest queued task: `{ "agent", "kinds"?, "sessionId"?, "leaseSeconds"? }`. Answers `{ "task": null }` when none fits |
| `POST /v1/tasks/:id/claim` | Claims that task: `{ "agent", "leaseSeconds"? }`. 409 when it isn't queued |
| `POST /v1/tasks/:id/progress` | `{ "leaseId", "message", "percent"?, "leaseSeconds"? }`. Also renews the lease |
| `POST /v1/tasks/:id/run` | `{ "leaseId" }`: the instance runs the task's operation and records the result, or the error, on the task |
| `POST /v1/tasks/:id/complete` | `{ "leaseId", "outcome": "succeeded" \| "failed", "result"?, "error"? }`: the agent reports its own result (at most 32 KB as JSON). A failure needs an `error` |
| `POST /v1/tasks/:id/cancel` | `{ "actor", "reason"? }`: cancels a queued or claimed task |

### Allowed kinds

Each kind is one of the instance's existing read-only operations, run with the same checks as its route. The input is checked when the task is made (400 for a bad one); checks that depend on the day, such as a brief date after today, are made when it runs and fail the task with the route's message.

| Kind | Runs | Input |
| --- | --- | --- |
| `reason` | `POST /v1/reason` | `departments`?: with department ids, such as `["inventory"]`, the result keeps only those departments' recommendations. The rules always run together, as they do on the route |
| `ask` | `POST /v1/ask` | `question` |
| `brief` | `GET /v1/brief` | `date`?, yesterday when left out |
| `verify` | `POST /v1/verify` | `from`, `to`, `system`?, `toleranceCents`? |
| `value` | `GET /v1/value` | `from` and `to`, or nothing for the month so far |
| `feedback` | `GET /v1/feedback` | none |
| `signals` | `GET /v1/signals` | `kinds`?, `limit`? |
| `recommendations` | `GET /v1/recommendations` | `limit`? |

Any other kind is turned down with 400 and the list above. **No kind writes to a vendor's system.** `verify` reads the source systems' own APIs; `reason` records recommendations in the instance's own store, as `POST /v1/reason` always has, and a `reason` task links the recommendations it kept to its session. Writes to a client's systems still go only through the [WriteGate](architecture/write-back.md), which stays off by default and which no task reaches. A test checks that the task code doesn't touch it.

"Check payout matches for last week" is a `verify` task for Stripe over those days, or an `ask` task with "which payouts are late?"; "re-run inventory reasoning" is a `reason` task with `departments: ["inventory"]`.

### Leases

A claim gives the agent a `leaseId` and a lease of `leaseSeconds` (default 300, from 10 to 3,600). The lease id is shown only in the claim's answer, never when the task is read. Every later call on the task carries it, and only the agent holding a live lease can report progress, run or complete the task. Progress renews the lease. `run` stretches it to 15 minutes while the operation runs.

When a lease runs out, the task goes back to the queue for the next agent, and the old lease id is turned down with 409. After a task has been claimed three times without finishing, a lease running out fails it instead. This is settled whenever a task route is called, so it holds across restarts too: a task left running when the instance stopped goes back to the queue once its lease runs out.

### Statuses

`queued` → `claimed` → `running` (while the instance runs it) → `succeeded` or `failed`. A queued or claimed task can be `cancelled`. A task's `resultBy` says whether the instance ran the operation (`brain`) or the agent reported the result (`agent`). When an operation fails with anything but its own refusal, only the error's class name is kept, since a message could quote business data.

## Audit trail

Every change is kept in `work_audit`, append-only: who (the actor, the agent, or `brain` for what the instance did itself), when, and what (`session.created`, `session.noted`, `session.linked`, `session.closed`, `session.reopened`, `task.created`, `task.claimed`, `task.progress`, `task.started`, `task.lease_expired`, `task.succeeded`, `task.failed`, `task.cancelled`). The change and its entry are written in one statement, so neither is ever kept without the other. Like every table, `reasoning_sessions`, `agent_tasks` and `work_audit` have row-level security keyed on the organization.

## Example

```sh
curl -s -X POST "$URL/v1/sessions" -H "authorization: Bearer $INSTANCE_API_KEY" \
  -d '{"subject": "Why did repairs slow down?", "actor": "owner", "idempotencyKey": "repairs-nov"}'
curl -s -X POST "$URL/v1/tasks" -H "authorization: Bearer $INSTANCE_API_KEY" \
  -d '{"sessionId": "ses_...", "kind": "reason", "input": {"departments": ["repairs"]}, "actor": "console"}'
curl -s -X POST "$URL/v1/tasks/claim" -H "authorization: Bearer $INSTANCE_API_KEY" -d '{"agent": "agent-a"}'
curl -s -X POST "$URL/v1/tasks/task_.../run" -H "authorization: Bearer $INSTANCE_API_KEY" -d '{"leaseId": "lease_..."}'
```
