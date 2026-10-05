# Incident runbook

These incidents degrade Brain A's reasoning or data. Each one is detected automatically, and each has a fix.

| Incident | How it shows up | What to do |
| --- | --- | --- |
| **Documentation drift** | Recommendations have `degraded: true`. `reasoning_runs.documentation.reason` says which doc is missing or at the wrong version. | Update the doc or the registry's expected version, record the change in `CHANGELOG.md`, and confirm the next run is not degraded. |
| **Dead letters piling up** | Rows in `dead_letter_events` with `resolved_at` null | Read `issues` to see which fields failed. Fix the connector or the source data, replay `raw`, then set `resolved_at`. |
| **Sync stuck** | `sync_checkpoints.updated_at` stops moving for a source | `runSync` retries a source three times with backoff, then stops at the last good checkpoint. Check the source system's status and credentials (`npm run secrets:plan`), then rerun. Nothing is lost or duplicated. |
| **Identity collision** | `IdentityCollisionError`: one source record linked to two different entities | Never merge silently. Decide which entity is right, then fix the `identities` row by hand and record why in `audit_log`. |
| **Wrong client's data** | API returns 403 "this instance does not serve that organization" | A connector or agent is pointed at the wrong instance. Check its URL and API key. The instance has already refused the data. |

## Useful queries

```sql
-- Open dead letters by source
select source, count(*) from dead_letter_events where resolved_at is null group by 1;

-- Recent degraded reasoning and why
select finished_at, documentation->>'reason' from reasoning_runs where degraded order by finished_at desc limit 10;

-- How far each sync has got
select source, stream, cursor, updated_at from sync_checkpoints order by updated_at;
```
