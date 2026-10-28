-- Slim copy: raw vendor data is cleared after the retention window
-- (RAW_RETENTION_DAYS, default 30). Rows are never deleted. Each keeps its
-- ids, idempotency key, a hash of what it held and a reference back to the
-- record in the client's own system. See docs/architecture/data-retention.md.

-- Events: where the record lives at the vendor, a hash of the payload, and when it was cleared.
alter table events add column if not exists source_record_id text;
alter table events add column if not exists source_url text check (source_url is null or source_url ~ '^https://');
alter table events add column if not exists payload_sha256 text check (payload_sha256 ~ '^[0-9a-f]{64}$');
alter table events add column if not exists payload_cleared_at timestamptz;

-- Events stored before this migration: the idempotency key is their source
-- reference, and the hash is taken over Postgres's own text form of the payload.
alter table events disable trigger events_append_only;
update events set
  source_record_id = coalesce(source_record_id, idempotency_key),
  payload_sha256 = coalesce(payload_sha256, encode(sha256(convert_to(payload::text, 'UTF8')), 'hex'));
alter table events enable trigger events_append_only;

-- Fills the source reference and hash for any insert that leaves them out.
create or replace function fill_event_source_reference() returns trigger
language plpgsql as $$
begin
  new.source_record_id := coalesce(new.source_record_id, new.idempotency_key);
  new.payload_sha256 := coalesce(new.payload_sha256, encode(sha256(convert_to(new.payload::text, 'UTF8')), 'hex'));
  return new;
end
$$;

drop trigger if exists events_source_reference on events;
create trigger events_source_reference
  before insert on events
  for each row execute function fill_event_source_reference();

alter table events alter column source_record_id set not null;
alter table events alter column payload_sha256 set not null;

-- Events stay append-only. The one change allowed is retention replacing the
-- payload with a tombstone, once, leaving every other column as it was.
create or replace function guard_event_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and old.payload_cleared_at is null
     and new.payload_cleared_at is not null
     and new.payload = jsonb_build_object('cleared', true, 'at', new.payload ->> 'at', 'reason', 'retention')
     and (to_jsonb(new) - 'payload' - 'payload_cleared_at') = (to_jsonb(old) - 'payload' - 'payload_cleared_at')
  then
    return new;
  end if;
  raise exception 'events are append-only';
end
$$;

drop trigger if exists events_append_only on events;
create trigger events_append_only
  before update or delete on events
  for each row execute function guard_event_mutation();

create index if not exists events_retention_idx on events (organization_id, received_at) where payload_cleared_at is null;

-- Dead letters hold raw input: keep a hash and the record id it named, clear the rest.
alter table dead_letter_events add column if not exists raw_sha256 text check (raw_sha256 ~ '^[0-9a-f]{64}$');
alter table dead_letter_events add column if not exists source_record_id text;
alter table dead_letter_events add column if not exists raw_cleared_at timestamptz;
update dead_letter_events set
  raw_sha256 = coalesce(raw_sha256, encode(sha256(convert_to(coalesce(raw, 'null'::jsonb)::text, 'UTF8')), 'hex')),
  source_record_id = coalesce(source_record_id, case when jsonb_typeof(raw) = 'object' then raw ->> 'idempotencyKey' end);
create index if not exists dead_letters_retention_idx on dead_letter_events (organization_id, received_at) where raw_cleared_at is null;

-- File imports keep their SHA-256, size and counts; this marks when the contents were let go.
alter table file_imports add column if not exists contents_cleared_at timestamptz;

-- Every purge, so the owner can see retention ran and what it cleared. Append-only.
create table if not exists retention_runs (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       text not null references organizations(id),
  ran_at                timestamptz not null,
  cutoff                timestamptz not null,
  retention_days        integer not null check (retention_days between 1 and 365),
  events_cleared        integer not null default 0 check (events_cleared >= 0),
  dead_letters_cleared  integer not null default 0 check (dead_letters_cleared >= 0),
  file_imports_cleared  integer not null default 0 check (file_imports_cleared >= 0),
  check (cutoff < ran_at)
);
create index if not exists retention_runs_recent_idx on retention_runs (organization_id, ran_at desc);

drop trigger if exists retention_runs_append_only on retention_runs;
create trigger retention_runs_append_only
  before update or delete on retention_runs
  for each row execute function reject_event_mutation();

alter table retention_runs enable row level security;
drop policy if exists tenant_isolation on retention_runs;
create policy tenant_isolation on retention_runs
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());
