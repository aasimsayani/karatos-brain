-- The instance API reads the latest signals of given kinds (GET /v1/signals?kind=...),
-- such as each bank account's balance or each open invoice, for the console.
create index if not exists signals_org_kind_recent_idx on signals (organization_id, kind, seq desc);
