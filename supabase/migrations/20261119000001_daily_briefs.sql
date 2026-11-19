-- The daily brief: one morning summary per store day, kept so the owner can
-- see it was built and what it said. The primary key is also what stops a
-- restarted instance from building the same day's brief twice.
create table if not exists daily_briefs (
  organization_id  text not null references organizations(id),
  day              date not null,
  generated_at     timestamptz not null,
  brief            jsonb not null,
  primary key (organization_id, day)
);

alter table daily_briefs enable row level security;
drop policy if exists tenant_isolation on daily_briefs;
create policy tenant_isolation on daily_briefs
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());
