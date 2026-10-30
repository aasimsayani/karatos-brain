-- What acting on a recommendation is worth, in cents: kind (makes, saves or
-- protects), likely, low and high amounts, and how it was worked out.
-- Null for recommendations made before this, or with no honest number.
alter table recommendations add column if not exists impact jsonb;
