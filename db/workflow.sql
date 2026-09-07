-- Additive integration metadata only. Existing feature data and CSV imports are preserved.
ALTER TABLE similar_search_runs
  ADD COLUMN IF NOT EXISTS extraction_revision integer;

ALTER TABLE approval_email_runs
  ADD COLUMN IF NOT EXISTS similar_search_run_id uuid REFERENCES similar_search_runs(run_id);

CREATE INDEX IF NOT EXISTS approval_email_search_idx
  ON approval_email_runs(similar_search_run_id);
