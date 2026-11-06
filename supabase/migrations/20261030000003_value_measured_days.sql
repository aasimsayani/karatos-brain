-- A measured result's checkpoint: 30, 60 or 90 days after its recommendation.
-- One per recommendation and checkpoint, so measuring twice can't double up.
alter table value_results add column if not exists measured_days int
  check (measured_days is null or (measured_days in (30, 60, 90) and source = 'measured'));
create unique index if not exists value_results_checkpoint_idx
  on value_results (organization_id, recommendation_id, measured_days)
  where measured_days is not null;
