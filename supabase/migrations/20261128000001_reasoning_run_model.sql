-- The model reasoner's audit record on each reasoning run: which model and
-- prompt version ran, the tokens it used, whether it succeeded, was skipped
-- or failed (with a fixed reason code), and how many findings it kept and
-- dropped. Counts and codes only, never the text sent or returned. Null for
-- runs without a model reasoner, and for runs stored before this.
alter table reasoning_runs add column if not exists model_reasoning jsonb;
