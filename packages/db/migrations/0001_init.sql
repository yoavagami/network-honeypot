-- Phase 1 schema. See docs/DATA_MODEL.md for the full design rationale.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- actors
-- ============================================================================
CREATE TABLE actors (
  actor_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  confidence     text NOT NULL DEFAULT 'low' CHECK (confidence IN ('low', 'medium', 'high')),
  risk_score     int NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  total_requests bigint NOT NULL DEFAULT 0,
  unique_paths   int NOT NULL DEFAULT 0,
  label          text,
  notes          text
);
CREATE INDEX idx_actors_last_seen ON actors (last_seen_at DESC);
CREATE INDEX idx_actors_risk ON actors (risk_score DESC);

CREATE TABLE actor_signals (
  id               bigserial PRIMARY KEY,
  actor_id         uuid NOT NULL REFERENCES actors (actor_id) ON DELETE CASCADE,
  signal_type      text NOT NULL CHECK (signal_type IN ('ip_hash', 'ua_fingerprint', 'visitor_id', 'tls_tuple')),
  signal_value     text NOT NULL,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  occurrence_count int NOT NULL DEFAULT 1,
  UNIQUE (actor_id, signal_type, signal_value)
);
CREATE INDEX idx_actor_signals_lookup ON actor_signals (signal_type, signal_value);

-- ============================================================================
-- sessions
-- ============================================================================
CREATE TABLE sessions (
  session_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id              uuid NOT NULL REFERENCES actors (actor_id) ON DELETE CASCADE,
  visitor_id            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  ip_hash               text NOT NULL,
  user_agent_raw        text,
  user_agent_fingerprint text,
  authenticated_as      text
);
CREATE INDEX idx_sessions_actor ON sessions (actor_id);
CREATE INDEX idx_sessions_visitor ON sessions (visitor_id);

-- ============================================================================
-- requests (partitioned by created_at, monthly)
-- ============================================================================
CREATE TABLE requests (
  request_id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  actor_id                       uuid NOT NULL REFERENCES actors (actor_id),
  session_id                     uuid,
  ip_hash                        text NOT NULL,
  ip_raw                         inet,
  source_port                    int,
  method                         text NOT NULL,
  scheme                         text NOT NULL,
  host                           text NOT NULL,
  path                           text NOT NULL,
  query_string                   text,
  http_version                   text,
  status_code                    int NOT NULL,
  request_bytes                  int NOT NULL DEFAULT 0,
  response_bytes                 int NOT NULL DEFAULT 0,
  duration_ms                    numeric NOT NULL DEFAULT 0,
  user_agent_raw                 text,
  user_agent_fingerprint         text,
  referer                        text,
  origin                         text,
  accept                         text,
  accept_language                text,
  accept_encoding                text,
  content_type                   text,
  forwarded_for_client_supplied  text,
  tls_version                    text,
  tls_cipher                     text,
  alpn                           text,
  endpoint                       text NOT NULL,
  application_component          text NOT NULL,
  risk_score                     int NOT NULL DEFAULT 0,
  PRIMARY KEY (request_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_requests_actor_created ON requests (actor_id, created_at);
CREATE INDEX idx_requests_path ON requests (path);
CREATE INDEX idx_requests_status ON requests (status_code);
CREATE INDEX idx_requests_created ON requests (created_at);
CREATE INDEX idx_requests_ip_created ON requests (ip_hash, created_at);

-- ============================================================================
-- events (partitioned by created_at, monthly)
-- ============================================================================
CREATE TABLE events (
  event_id     uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  request_id   uuid,
  actor_id     uuid NOT NULL REFERENCES actors (actor_id),
  session_id   uuid,
  event_type   text NOT NULL,
  severity     text NOT NULL DEFAULT 'info',
  risk_score   int NOT NULL DEFAULT 0,
  source       text NOT NULL DEFAULT 'inline_rule',
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (event_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_events_type_created ON events (event_type, created_at);
CREATE INDEX idx_events_actor_created ON events (actor_id, created_at);
CREATE INDEX idx_events_severity_created ON events (severity, created_at);

-- ============================================================================
-- monthly partitions: create previous, current, and next 2 months so local dev
-- and tests never fall outside a valid partition
-- ============================================================================
DO $$
DECLARE
  i int;
  start_date date;
  end_date date;
  suffix text;
BEGIN
  FOR i IN -1..2 LOOP
    start_date := date_trunc('month', now() + (i || ' month')::interval);
    end_date := start_date + interval '1 month';
    suffix := to_char(start_date, 'YYYY_MM');
    EXECUTE format('CREATE TABLE requests_%s PARTITION OF requests FOR VALUES FROM (%L) TO (%L)', suffix, start_date, end_date);
    EXECUTE format('CREATE TABLE events_%s PARTITION OF events FOR VALUES FROM (%L) TO (%L)', suffix, start_date, end_date);
  END LOOP;
END $$;

-- ============================================================================
-- detections
-- ============================================================================
CREATE TABLE detections (
  detection_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id         uuid NOT NULL REFERENCES actors (actor_id) ON DELETE CASCADE,
  detection_type   text NOT NULL,
  confidence       numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence         jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_event_at   timestamptz NOT NULL,
  last_event_at    timestamptz NOT NULL,
  event_count      int NOT NULL DEFAULT 1,
  acknowledged     boolean NOT NULL DEFAULT false,
  acknowledged_by  text,
  acknowledged_at  timestamptz
);
CREATE INDEX idx_detections_actor ON detections (actor_id);
CREATE INDEX idx_detections_type ON detections (detection_type);
CREATE INDEX idx_detections_ack ON detections (acknowledged);

-- ============================================================================
-- canary_objects / canary_events
-- ============================================================================
CREATE TABLE canary_objects (
  canary_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canary_type      text NOT NULL,
  value            text NOT NULL UNIQUE,
  planted_location text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  active           boolean NOT NULL DEFAULT true
);

CREATE TABLE canary_events (
  canary_event_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canary_id        uuid NOT NULL REFERENCES canary_objects (canary_id),
  actor_id         uuid NOT NULL REFERENCES actors (actor_id),
  request_id       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  usage_context    text NOT NULL
);
CREATE INDEX idx_canary_events_canary ON canary_events (canary_id);
CREATE INDEX idx_canary_events_actor ON canary_events (actor_id);

-- ============================================================================
-- synthetic_objects
-- ============================================================================
CREATE TABLE synthetic_objects (
  object_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type  text NOT NULL,
  public_ref   text NOT NULL,
  data         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_type, public_ref)
);

-- ============================================================================
-- admin_users / admin_audit_log
-- ============================================================================
CREATE TABLE admin_users (
  admin_user_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username       text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  mfa_secret     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  disabled       boolean NOT NULL DEFAULT false
);

CREATE TABLE admin_audit_log (
  audit_id       bigserial PRIMARY KEY,
  admin_user_id  uuid REFERENCES admin_users (admin_user_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  action         text NOT NULL,
  target         text,
  ip_hash        text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_audit_admin_created ON admin_audit_log (admin_user_id, created_at);

-- ============================================================================
-- least-privilege grants — see docs/ARCHITECTURE.md §3, docs/SECURITY.md §3
-- ============================================================================

-- honeypot_role: can write telemetry + manage actor/session/canary state it owns,
-- can read synthetic content it serves, CANNOT read admin_users/admin_audit_log.
GRANT SELECT, INSERT, UPDATE ON actors, actor_signals, sessions TO honeypot_role;
GRANT SELECT, INSERT ON requests, events, canary_events TO honeypot_role;
GRANT SELECT ON canary_objects, synthetic_objects TO honeypot_role;
GRANT SELECT, INSERT, UPDATE ON detections TO honeypot_role; -- correlation worker writes detections
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO honeypot_role;

-- admin_api_role: broad read for investigation, narrow write (audit log + detection
-- acknowledgement only). Explicitly NOT granted INSERT/UPDATE/DELETE on requests/events —
-- see THREAT_MODEL.md item #16 ("can I inject fake events?").
GRANT SELECT ON actors, actor_signals, sessions, requests, events, detections,
  canary_objects, canary_events, synthetic_objects, admin_users TO admin_api_role;
GRANT UPDATE (acknowledged, acknowledged_by, acknowledged_at) ON detections TO admin_api_role;
GRANT INSERT ON admin_audit_log TO admin_api_role;
GRANT UPDATE (last_login_at) ON admin_users TO admin_api_role;
GRANT USAGE ON SEQUENCE admin_audit_log_audit_id_seq TO admin_api_role;
