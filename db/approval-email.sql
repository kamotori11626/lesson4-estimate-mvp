-- Additive only. No customer, product, quote, or extraction data is rewritten.
CREATE TABLE IF NOT EXISTS approval_email_runs (
  run_id uuid PRIMARY KEY,
  extraction_run_id uuid NOT NULL REFERENCES extraction_runs(run_id),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  input_payload jsonb NOT NULL,
  approval_result jsonb NOT NULL,
  rule_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('required','not_required','hold'))
);
CREATE INDEX IF NOT EXISTS approval_email_extraction_idx ON approval_email_runs(extraction_run_id,created_at DESC);

CREATE TABLE IF NOT EXISTS approval_email_drafts (
  draft_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES approval_email_runs(run_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  draft_type text NOT NULL CHECK (draft_type IN ('customer_inquiry','internal_review','quote_notice')),
  recipient_role text NOT NULL,
  generation_method text NOT NULL CHECK (generation_method IN ('local_template','gemini_sanitized')),
  model text,
  prompt_version text NOT NULL,
  external_preview jsonb,
  generation_input jsonb NOT NULL,
  draft_payload jsonb NOT NULL,
  quality_result jsonb NOT NULL,
  subject text,
  body text,
  human_review jsonb,
  status text NOT NULL CHECK (status IN ('pending_review','quality_blocked','adopted','rejected')),
  revision integer NOT NULL DEFAULT 1
);
ALTER TABLE approval_email_drafts ADD COLUMN IF NOT EXISTS generation_input jsonb;

CREATE TABLE IF NOT EXISTS approval_email_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES approval_email_runs(run_id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  event_summary jsonb NOT NULL
);
