# Supabase setup

This runbook connects Brain A to a Supabase project and creates its database. You need a free Supabase account.

## 1. Copy three values from Supabase

In your project at [supabase.com/dashboard](https://supabase.com/dashboard):

| Setting | Where | Goes into `.env.local` as |
| --- | --- | --- |
| Project URL | Project Settings > API | `SUPABASE_URL` |
| anon public key | Project Settings > API | `SUPABASE_ANON_KEY` |
| Connection string (URI) | Project Settings > Database | `SUPABASE_DB_URL` |

The URL and both keys must come from the **same** project. Mixing projects is the most common cause of an HTTP 401.

## 2. Check the connection

```bash
cp .env.example .env.local   # then paste the values in
npm run env:check
npm run supabase:check
```

`supabase:check` prints `Supabase: OK` when the key is accepted, or explains what to fix.

## 3. Create the tables

```bash
npm run db:migrate           # add --seed to load the fictional demo store
```

Migrations run in filename order, each exactly once, and are recorded in `schema_migrations`. A failing migration is rolled back completely.

## What gets created

| Table | Layer | Notes |
| --- | --- | --- |
| `organizations` | All | One row per jewelry business |
| `events` | 1 Event Ingestion | Append-only; updates and deletes are rejected. Unique per (org, source, idempotency key) |
| `identities` | 2 Normalization | Maps source-system ids to canonical entities |
| `entities` | 2 Normalization | Latest version per entity; older versions never overwrite newer ones |
| `signals` | 3 Signal Extraction | Confidence must be between 0 and 1 |
| `recommendations` | 5 Reasoning | Stores provenance and the degraded flag |
| `feedback` | 6 Feedback | Accepted, rejected or overridden |
| `sync_checkpoints` | Connectors | Where each sync left off |
| `audit_log` | All | Every write to entities, recommendations and feedback |

Row-level security is on for every table. A request only sees rows whose `organization_id` matches the `organization_id` claim in its JWT. Server jobs using the service role bypass RLS.
