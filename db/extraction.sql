-- Additive only: never truncate or rewrite distributed CSV tables.
CREATE TABLE IF NOT EXISTS extraction_runs (
  run_id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  input_payload jsonb NOT NULL,
  output_payload jsonb NOT NULL,
  execution jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS extraction_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES extraction_runs(run_id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  event_summary jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS extraction_review_drafts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES extraction_runs(run_id),
  saved_at timestamptz NOT NULL DEFAULT now(),
  reviewer_id text NOT NULL,
  changes jsonb NOT NULL
);
-- Keep old records readable; do not fabricate a pre-edit snapshot for legacy rows.
ALTER TABLE extraction_runs ADD COLUMN IF NOT EXISTS initial_output jsonb;
ALTER TABLE extraction_runs ADD COLUMN IF NOT EXISTS business_review jsonb;
ALTER TABLE extraction_review_drafts ADD COLUMN IF NOT EXISTS business_review jsonb;

CREATE TABLE IF NOT EXISTS similar_search_runs (
  run_id uuid PRIMARY KEY,
  extraction_run_id uuid NOT NULL REFERENCES extraction_runs(run_id),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  input_payload jsonb NOT NULL,
  entity_candidates jsonb NOT NULL,
  selected_customer jsonb,
  selected_product jsonb,
  similar_quotes jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision jsonb,
  status text NOT NULL CHECK (status IN ('entity_review','quote_review','reviewed','error')),
  rule_version text NOT NULL,
  data_as_of timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS similar_search_extraction_idx ON similar_search_runs(extraction_run_id,created_at DESC);
CREATE TABLE IF NOT EXISTS similar_search_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES similar_search_runs(run_id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  event_summary jsonb NOT NULL
);
