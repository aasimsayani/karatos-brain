-- Completes the table set planned in the original Brain A design:
-- dead letters, reasoning runs, decisions, outcomes, memories and the
-- documentation registry. Entity kinds become open so department modules
-- can add their own.

alter table entities drop constraint if exists entities_kind_check;
alter table entities add constraint entities_kind_format check (kind ~ '^[a-z][a-z0-9_]*$');
alter table identities add constraint identities_kind_format check (entity_kind ~ '^[a-z][a-z0-9_]*$');

-- Inputs that failed validation, kept for repair and replay.
create table if not exists dead_letter_events (
  id               text primary key,
  organization_id  text references organizations(id),
  source           text,
  reason           text not null,
  issues           jsonb not null default '[]'::jsonb,
  raw              jsonb,
  received_at      timestamptz not null,
  resolved_at      timestamptz
);
create index if not exists dead_letters_open_idx on dead_letter_events (organization_id, received_at desc) where resolved_at is null;

-- Every reasoning pass, with the documentation state it ran against.
create table if not exists reasoning_runs (
  id                  text primary key,
  organization_id     text not null references organizations(id),
  started_at          timestamptz not null,
  finished_at         timestamptz not null,
  reasoners           text[] not null,
  documentation       jsonb not null,
  degraded            boolean not null,
  recommendation_ids  text[] not null default '{}'
);

-- What a person decided to do about a recommendation...
create table if not exists decisions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    text not null references organizations(id),
  recommendation_id  text not null references recommendations(id),
  decision           text not null,
  decided_by         text not null,
  decided_at         timestamptz not null default now()
);

-- ...and what actually happened, so confidence can be calibrated over time.
create table if not exists outcomes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references organizations(id),
  decision_id      uuid not null references decisions(id),
  metric           text not null,
  value            numeric,
  note             text,
  measured_at      timestamptz not null default now()
);

-- Long-lived knowledge about the business, searchable by text.
create table if not exists memories (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references organizations(id),
  subject_kind     text,
  subject_id       text,
  content          text not null,
  source_refs      jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  search           tsvector generated always as (to_tsvector('english', content)) stored
);
create index if not exists memories_search_idx on memories using gin (search);

-- Source-of-truth documents and the version reasoning expects.
create table if not exists documentation_registry (
  organization_id  text not null references organizations(id),
  document_id      text not null,
  title            text not null,
  expected_version text not null,
  current_version  text,
  last_checked_at  timestamptz,
  primary key (organization_id, document_id)
);

do $$
declare
  t text;
begin
  foreach t in array array['dead_letter_events', 'reasoning_runs', 'decisions', 'outcomes', 'memories', 'documentation_registry']
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

drop trigger if exists decisions_audit on decisions;
create trigger decisions_audit after insert or update on decisions
  for each row execute function write_audit_log();

drop trigger if exists outcomes_audit on outcomes;
create trigger outcomes_audit after insert or update on outcomes
  for each row execute function write_audit_log();
