-- Ingestion bookkeeping for every integration in the catalog: which systems an
-- instance has connected, every sync run, webhook deliveries, uploaded files
-- (bank statements, CSV exports) and the audit trail of write attempts.
-- Data itself still lands in the append-only events table; these tables say
-- where it came from and how each run went. Secrets are never stored here,
-- only the names of the secrets an instance reads from its secret store.

-- One row per connected system.
create table if not exists integration_connections (
  organization_id     text not null references organizations(id),
  integration_id      text not null check (integration_id ~ '^[a-z][a-z0-9_]*$'),
  status              text not null default 'pending'
                        check (status in ('pending', 'connected', 'paused', 'error', 'disconnected')),
  access              text not null check (access in ('public_api', 'partner', 'edi', 'file', 'unknown')),
  -- Names of secrets in the secret store, e.g. SHOPIFY_ADMIN_TOKEN. Never values.
  secret_names        text[] not null default '{}'
                        check (array_to_string(secret_names, ',') ~ '^([A-Z][A-Z0-9_]*(,[A-Z][A-Z0-9_]*)*)?$'),
  streams             text[] not null default '{}',
  historical_from     date,
  settings            jsonb not null default '{}'::jsonb,
  connected_at        timestamptz,
  last_synced_at      timestamptz,
  last_error          text,
  updated_at          timestamptz not null default now(),
  primary key (organization_id, integration_id)
);

-- Every historical import, incremental sync, webhook batch and file import.
create table if not exists sync_runs (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null references organizations(id),
  source            text not null,
  stream            text not null,
  mode              text not null check (mode in ('historical', 'incremental', 'webhook', 'file')),
  status            text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  cursor_before     text,
  cursor_after      text,
  batches           integer not null default 0 check (batches >= 0),
  ingested          integer not null default 0 check (ingested >= 0),
  duplicates        integer not null default 0 check (duplicates >= 0),
  dead_lettered     integer not null default 0 check (dead_lettered >= 0),
  error             text,
  check ((status = 'running') = (finished_at is null))
);
create index if not exists sync_runs_recent_idx on sync_runs (organization_id, source, started_at desc);
create index if not exists sync_runs_open_idx on sync_runs (organization_id) where status = 'running';

-- Webhook deliveries, so a vendor's retries are processed once.
create table if not exists webhook_deliveries (
  organization_id  text not null references organizations(id),
  source           text not null,
  delivery_id      text not null,
  topic            text not null,
  payload_sha256   text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at      timestamptz not null default now(),
  sync_run_id      uuid references sync_runs(id),
  primary key (organization_id, source, delivery_id)
);

-- Uploaded files: bank and card statements (CSV or PDF), refiner statements,
-- appraisal exports. The file lives in storage; this row tracks it.
create table if not exists file_imports (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    text not null references organizations(id),
  source             text not null,
  file_name          text not null,
  media_type         text not null check (media_type in ('text/csv', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/json', 'text/plain')),
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size          bigint not null check (byte_size > 0),
  storage_path       text not null,
  period_start       date,
  period_end         date,
  status             text not null default 'received'
                       check (status in ('received', 'parsing', 'parsed', 'needs_review', 'failed')),
  rows_total         integer check (rows_total >= 0),
  sync_run_id        uuid references sync_runs(id),
  uploaded_by        text not null,
  uploaded_at        timestamptz not null default now(),
  error              text,
  -- The same statement uploaded twice is one import.
  unique (organization_id, sha256),
  check (period_end is null or period_start is null or period_end >= period_start)
);
create index if not exists file_imports_recent_idx on file_imports (organization_id, source, uploaded_at desc);

-- How entities relate: an order's customer, a repair's product, a memo's supplier.
create table if not exists entity_links (
  organization_id   text not null references organizations(id),
  from_kind         text not null check (from_kind ~ '^[a-z][a-z0-9_]*$'),
  from_id           text not null,
  relation          text not null check (relation ~ '^[a-z][a-z0-9_]*$'),
  to_kind           text not null check (to_kind ~ '^[a-z][a-z0-9_]*$'),
  to_id             text not null,
  source_event_ids  text[] not null default '{}',
  updated_at        timestamptz not null default now(),
  primary key (organization_id, from_kind, from_id, relation, to_kind, to_id)
);
create index if not exists entity_links_reverse_idx on entity_links (organization_id, to_kind, to_id, relation);

-- Every write attempt to a client's system, including refusals. Append-only.
create table if not exists write_audit (
  id               bigint generated always as identity primary key,
  organization_id  text not null references organizations(id),
  integration      text not null,
  action           text not null,
  requested_by     text not null,
  outcome          text not null check (outcome in ('refused', 'performed', 'failed')),
  error            text,
  at               timestamptz not null
);
create index if not exists write_audit_recent_idx on write_audit (organization_id, at desc);

drop trigger if exists write_audit_append_only on write_audit;
create trigger write_audit_append_only
  before update or delete on write_audit
  for each row execute function reject_event_mutation();

-- Indexes for reading the data back by system, by entity kind and by entity.
create index if not exists events_org_source_idx on events (organization_id, source, occurred_at desc);
create index if not exists entities_org_kind_recent_idx on entities (organization_id, kind, updated_at desc);
create index if not exists identities_entity_idx on identities (organization_id, entity_kind, entity_id);

do $$
declare
  t text;
begin
  foreach t in array array['integration_connections', 'sync_runs', 'webhook_deliveries', 'file_imports', 'entity_links', 'write_audit']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (organization_id = current_organization_id()) with check (organization_id = current_organization_id())',
      t
    );
  end loop;
end
$$;

-- The migration ledger is for the service role only; with RLS on and no
-- policy, the anon and authenticated roles can't read or change it.
alter table if exists schema_migrations enable row level security;

drop trigger if exists integration_connections_audit on integration_connections;
create trigger integration_connections_audit after insert or update on integration_connections
  for each row execute function write_audit_log();
