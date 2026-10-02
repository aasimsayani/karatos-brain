-- Tenants only ever see their own organization's rows.
do $$
declare
  t text;
begin
  foreach t in array array['events', 'identities', 'entities', 'signals', 'recommendations', 'feedback', 'sync_checkpoints', 'audit_log']
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

alter table organizations enable row level security;
drop policy if exists tenant_isolation on organizations;
create policy tenant_isolation on organizations using (id = current_organization_id());
