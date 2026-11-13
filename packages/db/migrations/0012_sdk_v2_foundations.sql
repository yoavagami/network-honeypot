-- SDK v2, Phase A foundations — see SDK_V2_IMPLEMENTATION_PLAN.md §2 / §4.4.
--
-- 1. Page-load ids become real, indexed columns (they were only in request_signals.data).
-- 2. Lab labels carry whether they came from a signed link (ground truth) or a bare ?lab=
--    (claimed). Existing rows predate signing, so they are all "claimed".
-- 3. client_signals.bound: did the beacon's page-load id belong to a page served to this
--    visitor? NULL = not checked (rows from before this migration).
-- 4. lab_runs: signed lab links minted from the dashboard.
-- 5. visit_scores / visit_requests: the scoring worker's stored verdict per visit, so the
--    Agents list is an indexed query instead of rescoring 25k requests per page view.
--
-- Indexes are built without CONCURRENTLY because migrate.ts runs each file in a transaction;
-- at the current table sizes the lock is momentary.

ALTER TABLE request_signals
  ADD COLUMN page_load_id text,
  ADD COLUMN lab_verified boolean NOT NULL DEFAULT false;
UPDATE request_signals SET page_load_id = data ->> 'pageLoadId' WHERE data ? 'pageLoadId' AND data ->> 'pageLoadId' IS NOT NULL;
CREATE INDEX idx_request_signals_page_load ON request_signals (page_load_id) WHERE page_load_id IS NOT NULL;

ALTER TABLE client_signals
  ADD COLUMN lab_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN bound boolean,
  ADD COLUMN schema_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN sdk_version text;
CREATE INDEX idx_client_signals_page_load ON client_signals (page_load_id) WHERE page_load_id IS NOT NULL;
CREATE INDEX idx_client_signals_actor_created ON client_signals (actor_id, created_at);

CREATE TABLE lab_runs (
  label       text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('agent', 'human')),
  agent       text,
  scenario    text,
  notes       text,
  created_by  uuid REFERENCES admin_users (admin_user_id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE TABLE visit_scores (
  visit_id        text PRIMARY KEY,
  scorer_version  text NOT NULL,
  computed_at     timestamptz NOT NULL,
  -- true once the visit has been quiet for the 30-minute visit gap and was rescored after that
  settled         boolean NOT NULL DEFAULT false,
  actor_id        uuid NOT NULL,
  session_id      uuid,
  first_at        timestamptz NOT NULL,
  last_at         timestamptz NOT NULL,
  request_count   integer NOT NULL,
  page_count      integer NOT NULL,
  lab_label       text,
  lab_verified    boolean NOT NULL DEFAULT false,
  probability     double precision NOT NULL,
  bucket          text NOT NULL,
  type            text NOT NULL,
  agent           text,
  proven          boolean NOT NULL,
  signals         text[] NOT NULL DEFAULT '{}',
  reasons         jsonb NOT NULL,
  -- raw IP for display; NULL'd by retention.ts after RAW_IP_RETENTION_DAYS like requests.ip_raw
  ip              inet,
  -- network, asn, country, userAgent, ja4, hasBrowserBeacon, shop summary, checks summary
  summary         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_visit_scores_last_at ON visit_scores (last_at DESC);
CREATE INDEX idx_visit_scores_bucket ON visit_scores (bucket, last_at DESC);
CREATE INDEX idx_visit_scores_actor ON visit_scores (actor_id);
CREATE INDEX idx_visit_scores_session ON visit_scores (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_visit_scores_lab ON visit_scores (lab_label) WHERE lab_label IS NOT NULL;
CREATE INDEX idx_visit_scores_signals ON visit_scores USING gin (signals);
CREATE INDEX idx_visit_scores_unsettled ON visit_scores (last_at) WHERE NOT settled;

-- Which visit each request belongs to (for the per-request tab and request → visit lookups).
CREATE TABLE visit_requests (
  request_id  uuid PRIMARY KEY,
  visit_id    text NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX idx_visit_requests_visit ON visit_requests (visit_id);
CREATE INDEX idx_visit_requests_created ON visit_requests (created_at);

-- The scoring worker runs inside the honeypot process (it already reads all of these tables for
-- correlation), so it gets write access to the two derived tables only.
GRANT SELECT, INSERT, UPDATE, DELETE ON visit_scores, visit_requests TO honeypot_role;
GRANT SELECT ON visit_scores, visit_requests, lab_runs TO admin_api_role;
GRANT INSERT ON lab_runs TO admin_api_role;
