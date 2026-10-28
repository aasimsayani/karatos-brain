# Data retention: the slim copy

Brain A keeps a slim copy of a client's data. It keeps the cleaned-up facts and the signals built on them, each with a link back to the record it came from, and it clears raw vendor data after 30 days.

The client's own systems (their store, POS, payments, bank and books) stay the source of truth. Holding a second full copy of every vendor record would make each instance a store of the client's data, with the cost and responsibility that come with it. Brain A doesn't need the raw copy to do its job: once a record has been turned into entities and signals, the raw version is only useful for checking a detail, and the vendor can give us that again.

## What is kept

Kept for as long as the instance runs:

| What | Where | Why |
| --- | --- | --- |
| Cleaned-up facts: customers, products, orders, payments and every department's own kinds | `entities` | What reasoning works from |
| How facts relate (an order's customer, a repair's product) | `entity_links` | Same |
| Signals, recommendations, reasoning runs | `signals`, `recommendations`, `reasoning_runs` | Every recommendation stays explainable |
| Decisions, outcomes, feedback, memories | `decisions`, `outcomes`, `feedback`, `memories` | What the owner chose and what happened, for learning |
| Which record in the source system is which entity | `identities` | One customer or product is one entity across systems |
| Connections, sync runs, checkpoints, webhook deliveries | `integration_connections`, `sync_runs`, `sync_checkpoints`, `webhook_deliveries` | What ran and when. Webhook deliveries already hold only a SHA-256 of what was sent. |
| Audit trails | `audit_log`, `write_audit` | Who changed what |
| Every event row, minus its raw payload once cleared | `events` | See below |
| Every retention run | `retention_runs` | So the owner can see the purge ran and what it cleared |

## What is cleared

Raw vendor data older than the window (30 days by default) is cleared:

| What | Where | What stays on the row |
| --- | --- | --- |
| Event payloads: the record as a connector received it | `events.payload` | The event id, type, times, source, idempotency key, the source reference (`source`, `source_record_id`, `source_url`), the payload's SHA-256 and `payload_cleared_at` |
| Input that failed validation | `dead_letter_events.raw` | The id, source, reason, validation issues, the record id the input named, the input's SHA-256 and `raw_cleared_at` |
| Uploaded file contents (statements, POS exports) | `file_imports` | The file's SHA-256, size, name, period, row count, status and `contents_cleared_at` |

Clearing replaces the payload with a small marker:

```json
{ "cleared": true, "at": "2026-11-21T03:00:00.000Z", "reason": "retention" }
```

Rows are never deleted. Signals, entities and recommendations cite event ids, and those ids keep resolving to a row with its source reference after the payload is gone. The database enforces this: events are append-only, and the only change it allows is replacing a payload with that marker, once, with every other column left as it was.

The window counts from when Brain A received the data (`received_at`, or `uploaded_at` for files), not from when it happened at the vendor. A five-year history import is kept for 30 days from the import.

Dead letters that named no organization belong to the instance, so its purge clears them too.

For files, Brain A's database never holds file contents, only a pointer (`storage_path`) to where the file was put. The purge marks the import as cleared; the folder or bucket that holds the uploaded file should delete files on the same window (for example a storage lifecycle rule), and anything still pointing at a cleared import should treat the file as gone.

## The source reference

Every event row carries a source reference: the source system (`source`), the vendor's id for the record (`source_record_id`) and, when the connector knows one, a link to the record in the vendor's app (`source_url`, https only). A connector declares it with the envelope's optional `sourceRecord: { id, url? }`. When it doesn't, Brain A uses the first id in the payload in the source's own form (for example `shopify:order:1001`), and failing that the event's idempotency key.

Entities, links and signals list the events they came from (`sourceEventIds`, `derivedFromEventIds`), and recommendations list them in their provenance, so every kept record resolves to the record in the client's system. `MemoryStore.getEvent(organizationId, id)` returns the event with its `sourceRef`, whether or not its payload has been cleared.

## Reading the raw detail after 30 days

When a reasoner, the console or a person needs a detail that only the raw record had, it uses the source reference to read that record again from the vendor, through that integration's read-only connector, or opens `source_url` in the vendor's app. Brain A doesn't keep its own copy for this. Re-reading from the vendor also means the detail is current, not a month-old copy.

Building those re-reads for each connector is separate work; this change only keeps what they need.

## Re-imports and replays

Clearing a payload keeps the event's idempotency key, so a vendor retry, a webhook replay or a re-run of a historical import within or after the window is still recognized as a duplicate and stored once. A record that changed at the vendor has a new key and arrives as a new event, as it always did.

To bring raw detail back for a period, re-read it from the vendor with a new import. Because keys of unchanged records are already stored, that import counts them as duplicates and doesn't store them again; it only adds what is new or changed. The facts and signals built from the original import are still there.

A file uploaded again after its contents were cleared is still matched by its SHA-256, so it's recognized as the same import.

## How the purge runs

`purgeRawData(organizationId, now, retentionDays)` is on both stores (`PostgresMemoryStore`, and `InMemoryStore` for tests). It clears what is older than the window, returns counts of events, dead letters and file imports cleared, and records the run in `retention_runs` (row-level security on, append-only). Running it twice changes nothing the second time. Data exactly `retentionDays` old is kept; anything older is cleared.

An instance runs the purge when it starts and then once a day, and logs the counts.

## Changing the window

Set `RAW_RETENTION_DAYS` in the instance's settings: a whole number of days from 1 to 365. Empty means 30. The instance will not start with any other value. A shorter window clears more at the next daily purge. A longer window keeps raw data longer from then on, but it can't bring back anything already cleared; re-read that from the vendor.
