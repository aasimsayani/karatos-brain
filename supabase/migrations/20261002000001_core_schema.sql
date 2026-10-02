-- Brain A core schema: the Memory + State layer.
-- Every row carries organization_id; row-level security keeps tenants apart.

create table if not exists organizations (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Organization of the caller, read from the JWT claims Supabase/PostgREST sets per request.
-- Server-side jobs using the service role bypass RLS and do not need it.
create or replace function current_organization_id() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'organization_id'
$$;

-- Layer 1: append-only event log.
create table if not exists events (
  id               text primary key,
  organization_id  text not null references organizations(id),
  source           text not null,
  type             text not null,
  occurred_at      timestamptz not null,
  received_at      timestamptz not null,
  idempotency_key  text not null,
  payload          jsonb not null default '{}'::jsonb,
  inserted_at      timestamptz not null default now(),
  unique (organization_id, source, idempotency_key)
);
create index if not exists events_org_type_idx on events (organization_id, type, occurred_at desc);

create or replace function reject_event_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'events are append-only';
end
$$;

drop trigger if exists events_append_only on events;
create trigger events_append_only
  before update or delete on events
  for each row execute function reject_event_mutation();

-- Identity resolution: maps a record in a source system to a canonical entity.
create table if not exists identities (
  organization_id  text not null references organizations(id),
  source           text not null,
  external_id      text not null,
  entity_kind      text not null,
  entity_id        text not null,
  created_at       timestamptz not null default now(),
  primary key (organization_id, source, external_id)
);

-- Layer 2: canonical entities, latest version per (org, kind, id).
create table if not exists entities (
  organization_id   text not null references organizations(id),
  kind              text not null check (kind in ('customer', 'product', 'order', 'payment', 'supplier')),
  id                text not null,
  attributes        jsonb not null default '{}'::jsonb,
  source_event_ids  text[] not null default '{}',
  updated_at        timestamptz not null,
  primary key (organization_id, kind, id)
);

-- Layer 3: signals.
create table if not exists signals (
  seq                    bigint generated always as identity,
  id                     text primary key,
  organization_id        text not null references organizations(id),
  kind                   text not null,
  subject_kind           text not null,
  subject_id             text not null,
  value                  jsonb not null,
  confidence             numeric not null check (confidence between 0 and 1),
  derived_from_event_ids text[] not null default '{}',
  observed_at            timestamptz not null,
  inserted_at            timestamptz not null default now()
);
create index if not exists signals_org_recent_idx on signals (organization_id, seq desc);

-- Layer 5: recommendations.
create table if not exists recommendations (
  id               text primary key,
  organization_id  text not null references organizations(id),
  summary          text not null,
  confidence       numeric not null check (confidence between 0 and 1),
  expected_impact  text not null,
  provenance       jsonb not null,
  degraded         boolean not null,
  created_at       timestamptz not null
);

-- Layer 6: human feedback on recommendations.
create table if not exists feedback (
  id                 uuid primary key default gen_random_uuid(),
  recommendation_id  text not null references recommendations(id),
  organization_id    text not null references organizations(id),
  outcome            text not null check (outcome in ('accepted', 'rejected', 'overridden')),
  note               text,
  actor              text not null,
  recorded_at        timestamptz not null
);

-- Where each connector left off, so syncs resume instead of restarting.
create table if not exists sync_checkpoints (
  organization_id  text not null references organizations(id),
  source           text not null,
  stream           text not null,
  cursor           text,
  updated_at       timestamptz not null default now(),
  primary key (organization_id, source, stream)
);

-- Audit trail of every write to decision-bearing tables.
create table if not exists audit_log (
  id               bigint generated always as identity primary key,
  organization_id  text,
  table_name       text not null,
  action           text not null,
  row_data         jsonb not null,
  actor            text,
  at               timestamptz not null default now()
);

create or replace function write_audit_log() returns trigger
language plpgsql as $$
begin
  insert into audit_log (organization_id, table_name, action, row_data, actor)
  values (
    new.organization_id,
    tg_table_name,
    tg_op,
    to_jsonb(new),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  );
  return new;
end
$$;

drop trigger if exists recommendations_audit on recommendations;
create trigger recommendations_audit after insert or update on recommendations
  for each row execute function write_audit_log();

drop trigger if exists feedback_audit on feedback;
create trigger feedback_audit after insert or update on feedback
  for each row execute function write_audit_log();

drop trigger if exists entities_audit on entities;
create trigger entities_audit after insert or update on entities
  for each row execute function write_audit_log();
