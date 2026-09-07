CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash text PRIMARY KEY,
  username text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx ON app_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  attempt_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  failure_count integer NOT NULL DEFAULT 0,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_username text,
  actor_display_name text,
  event_type text NOT NULL,
  event_summary jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS app_audit_events_time_idx ON app_audit_events(occurred_at DESC);

CREATE TABLE IF NOT EXISTS app_metadata (
  metadata_key text PRIMARY KEY,
  metadata_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_metadata(metadata_key, metadata_value)
VALUES ('dataset_type', 'demo')
ON CONFLICT (metadata_key) DO NOTHING;
