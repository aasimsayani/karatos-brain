-- The value ledger: what acting on a recommendation brought back, recorded
-- after the fact, measured from the store's own data or reported by a person.
-- A later result for the same recommendation (measured again at 60 or 90
-- days) replaces the earlier one in the report; both are kept.
create table if not exists value_results (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    text not null references organizations(id),
  recommendation_id  text not null references recommendations(id),
  kind               text not null check (kind in ('makes', 'saves', 'protects')),
  cents              bigint not null check (cents >= 0),
  source             text not null check (source in ('measured', 'reported')),
  note               text,
  actor              text not null check (length(btrim(actor)) > 0),
  recorded_at        timestamptz not null
);
create index if not exists value_results_recommendation_idx on value_results (organization_id, recommendation_id, recorded_at);

-- The report reads a month of recommendations at a time.
create index if not exists recommendations_org_created_idx on recommendations (organization_id, created_at);

alter table value_results enable row level security;
drop policy if exists tenant_isolation on value_results;
create policy tenant_isolation on value_results
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());
