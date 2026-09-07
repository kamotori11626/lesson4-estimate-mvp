CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS import_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  source_name text NOT NULL,
  source_row_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  error_message text
);

CREATE TABLE IF NOT EXISTS customer_master_raw (
  source_row_no integer PRIMARY KEY,
  customer_id text,
  customer_name text,
  billing_name text,
  delivery_site text,
  sales_rep text,
  payment_terms text,
  closing_date text,
  special_discount_rule text,
  credit_rank text,
  source_payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS product_master_raw (
  source_row_no integer PRIMARY KEY,
  product_id text,
  product_code text,
  product_name text,
  material text,
  unit text,
  discontinued_flag text,
  note text,
  source_payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS past_quote_raw (
  source_row_no integer PRIMARY KEY,
  quote_no text,
  quote_date text,
  customer_name text,
  product_code text,
  material text,
  process_type text,
  quantity text,
  quote_price text,
  cost_estimate text,
  gross_margin_rate text,
  approved_by text,
  approval_reason text,
  note text,
  drawing_link text,
  source_payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS quote_request_log_raw (
  source_row_no integer PRIMARY KEY,
  rfq_id text,
  received_date text,
  customer_name text,
  sales_rep text,
  request_channel text,
  product_text text,
  quantity text,
  requested_delivery_date text,
  has_drawing text,
  missing_info_flag text,
  quote_submitted_date text,
  quote_amount text,
  gross_margin_rate text,
  order_result text,
  lost_reason text,
  follow_up_done text,
  required_tech_review text,
  required_supplier_quote text,
  source_payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_master_raw (
  source_row_no integer PRIMARY KEY,
  supplier_id text,
  supplier_name text,
  process_specialty text,
  avg_response_days text,
  on_time_delivery_rate text,
  defect_rate text,
  min_lot text,
  emergency_available text,
  contact_method text,
  source_payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_search (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  display_name text NOT NULL,
  normalized_name text NOT NULL,
  search_text text NOT NULL,
  source_row_no integer NOT NULL,
  source_payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS entity_search_type_idx ON entity_search (entity_type);
CREATE INDEX IF NOT EXISTS entity_search_normalized_name_trgm_idx
  ON entity_search USING gin (normalized_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS entity_search_text_trgm_idx
  ON entity_search USING gin (search_text gin_trgm_ops);

CREATE TABLE IF NOT EXISTS environment_write_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT now(),
  check_label text NOT NULL
);

CREATE OR REPLACE VIEW data_quality_summary AS
SELECT 'customer_missing_payment_terms' AS issue, count(*)::integer AS affected_rows
FROM customer_master_raw WHERE nullif(trim(payment_terms), '') IS NULL
UNION ALL
SELECT 'customer_missing_closing_date', count(*)::integer
FROM customer_master_raw WHERE nullif(trim(closing_date), '') IS NULL
UNION ALL
SELECT 'product_missing_material', count(*)::integer
FROM product_master_raw WHERE nullif(trim(material), '') IS NULL
UNION ALL
SELECT 'past_quote_missing_approver', count(*)::integer
FROM past_quote_raw WHERE nullif(trim(approved_by), '') IS NULL
UNION ALL
SELECT 'past_quote_missing_approval_reason', count(*)::integer
FROM past_quote_raw WHERE nullif(trim(approval_reason), '') IS NULL
UNION ALL
SELECT 'product_duplicate_code_rows', coalesce(sum(group_count), 0)::integer
FROM (
  SELECT count(*) AS group_count
  FROM product_master_raw
  WHERE nullif(trim(product_code), '') IS NOT NULL
  GROUP BY upper(regexp_replace(product_code, '[^A-Za-z0-9]', '', 'g'))
  HAVING count(*) > 1
) duplicate_products
UNION ALL
SELECT 'customer_name_variant_rows', coalesce(sum(group_count), 0)::integer
FROM (
  SELECT count(*) AS group_count
  FROM entity_search
  WHERE entity_type = 'customer' AND normalized_name <> ''
  GROUP BY normalized_name
  HAVING count(DISTINCT display_name) > 1
) customer_variants;
