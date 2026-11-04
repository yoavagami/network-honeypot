-- Agent sensing — see apps/honeypot/src/sensing/ and apps/honeypot/src/edge/.
--
-- request_signals: one row per captured request with everything the server can observe about
-- *who* sent it — TLS/HTTP2 fingerprints from the edge sensor, full header order, Web Bot Auth
-- verification, IP intelligence and the resulting identity verdict (verified / spoofed /
-- claimed / automation / browser). The few columns analysis filters on are promoted out of
-- `data`; everything else stays in jsonb so the capture can grow without migrations.
--
-- client_signals: what the fingerprint script (/assets/app.js) reports from inside the browser —
-- device/browser fingerprint, automation tells, injected agent DOM artifacts, behavior.
--
-- lab_label: set from ?lab=<label> (cookie hp_lab) so controlled test runs of a known agent are
-- labeled ground truth. Neither table stores cookie values, authorization values or passwords.
CREATE TABLE request_signals (
  request_id        uuid PRIMARY KEY,
  created_at        timestamptz NOT NULL,
  actor_id          uuid NOT NULL,
  session_id        uuid,
  lab_label         text,
  ja4               text,
  ja3n_hash         text,
  h2_fp             text,
  header_order_hash text,
  ua_claim          text,
  ua_library        text,
  wba_status        text NOT NULL,
  wba_signer        text,
  identity_verdict  text NOT NULL,
  identity_agent    text,
  ip_agent_range    text,
  ip_tor            boolean NOT NULL DEFAULT false,
  data              jsonb NOT NULL
);
CREATE INDEX idx_request_signals_created_at ON request_signals (created_at);
CREATE INDEX idx_request_signals_actor ON request_signals (actor_id);
CREATE INDEX idx_request_signals_session ON request_signals (session_id);
CREATE INDEX idx_request_signals_ja4 ON request_signals (ja4);
CREATE INDEX idx_request_signals_lab ON request_signals (lab_label) WHERE lab_label IS NOT NULL;
CREATE INDEX idx_request_signals_verdict ON request_signals (identity_verdict);

CREATE TABLE client_signals (
  id           uuid PRIMARY KEY,
  created_at   timestamptz NOT NULL,
  actor_id     uuid NOT NULL,
  session_id   uuid,
  visitor_id   text,
  lab_label    text,
  page_load_id text,
  kind         text NOT NULL,
  path         text,
  data         jsonb NOT NULL
);
CREATE INDEX idx_client_signals_created_at ON client_signals (created_at);
CREATE INDEX idx_client_signals_actor ON client_signals (actor_id);
CREATE INDEX idx_client_signals_session ON client_signals (session_id);
CREATE INDEX idx_client_signals_lab ON client_signals (lab_label) WHERE lab_label IS NOT NULL;

GRANT SELECT, INSERT ON request_signals, client_signals TO honeypot_role;
GRANT SELECT ON request_signals, client_signals TO admin_api_role;
