-- Reasoning sessions and agent tasks: the work around one question, kept so
-- it can be picked up again after a restart. A session groups notes, links
-- to the recommendations and evidence it touched, and the tasks run for it.
-- A task is one read-only operation an outside agent claims under a lease
-- that runs out. Every change is kept in work_audit, which is append-only.
create table if not exists reasoning_sessions (
  organization_id   text not null references organizations(id),
  id                text not null,
  subject           text not null check (length(subject) between 1 and 300),
  status            text not null check (status in ('open', 'closed')),
  created_by        text not null,
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  closed_at         timestamptz,
  notes             jsonb not null default '[]' check (jsonb_typeof(notes) = 'array' and jsonb_array_length(notes) <= 200),
  links             jsonb not null default '[]' check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 500),
  idempotency_key   text,
  request_hash      text,
  primary key (organization_id, id),
  check ((status = 'closed') = (closed_at is not null)),
  check ((idempotency_key is null) = (request_hash is null))
);
create unique index if not exists reasoning_sessions_idempotency_idx on reasoning_sessions (organization_id, idempotency_key) where idempotency_key is not null;
create index if not exists reasoning_sessions_recent_idx on reasoning_sessions (organization_id, updated_at desc);

create table if not exists agent_tasks (
  organization_id   text not null references organizations(id),
  id                text not null,
  session_id        text not null,
  kind              text not null,
  input             jsonb not null default '{}',
  status            text not null check (status in ('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled')),
  created_by        text not null,
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  attempts          integer not null default 0 check (attempts >= 0),
  lease_agent       text,
  lease_id          text,
  lease_claimed_at  timestamptz,
  lease_expires_at  timestamptz,
  progress          jsonb,
  result            jsonb,
  result_by         text check (result_by in ('brain', 'agent')),
  error             text,
  finished_at       timestamptz,
  idempotency_key   text,
  request_hash      text,
  primary key (organization_id, id),
  foreign key (organization_id, session_id) references reasoning_sessions (organization_id, id),
  -- A claimed or running task always has a whole lease; a queued one never does.
  check (status not in ('claimed', 'running') or (lease_id is not null and lease_agent is not null and lease_claimed_at is not null and lease_expires_at is not null)),
  check (status <> 'queued' or lease_id is null),
  check ((status in ('succeeded', 'failed', 'cancelled')) = (finished_at is not null)),
  check ((idempotency_key is null) = (request_hash is null))
);
create unique index if not exists agent_tasks_idempotency_idx on agent_tasks (organization_id, idempotency_key) where idempotency_key is not null;
create index if not exists agent_tasks_session_idx on agent_tasks (organization_id, session_id, created_at desc);
create index if not exists agent_tasks_queue_idx on agent_tasks (organization_id, status, created_at);
create index if not exists agent_tasks_leases_idx on agent_tasks (organization_id, lease_expires_at) where status in ('claimed', 'running');

create table if not exists work_audit (
  id               bigint generated always as identity primary key,
  organization_id  text not null references organizations(id),
  session_id       text not null,
  task_id          text,
  action           text not null,
  actor            text not null,
  at               timestamptz not null,
  detail           jsonb not null default '{}'
);
create index if not exists work_audit_session_idx on work_audit (organization_id, session_id, id);

drop trigger if exists work_audit_append_only on work_audit;
create trigger work_audit_append_only
  before update or delete on work_audit
  for each row execute function reject_event_mutation();

do $$
declare
  t text;
begin
  foreach t in array array['reasoning_sessions', 'agent_tasks', 'work_audit']
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
