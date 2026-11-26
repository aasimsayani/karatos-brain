-- The feedback loop: which rule (reasoner) raised each recommendation, so
-- the next run can rank a rule by how the store treated its earlier
-- recommendations, and how feedback set this one's confidence (the rule's
-- own confidence, the factor applied and why). Both are null for
-- recommendations stored before this, which the loop leaves out of a
-- rule's history.
alter table recommendations add column if not exists rule text;
alter table recommendations add column if not exists ranking jsonb;
