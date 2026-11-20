-- Alerts on the public merchant pages (apps/merchant-api/src/siteAlerts.ts): someone read the agent
-- file or the developer guide, or sent the request-access form. Page reads: at most one alert per IP and
-- kind every 6 hours; every access request alerts. Admin-only like public_page_hits: shown on Merchants → "Site alerts" and, when
-- MERCHANT_ALERT_URL is set, pushed there.
CREATE TABLE public_site_alerts (
  alert_id     bigserial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- agent_file | developer_guide | access_request
  kind         text NOT NULL,
  path         text NOT NULL,
  ip           inet,
  country      text,
  network      text,
  user_agent   text,
  agent        text,
  -- access_request only: the company name from the form (no email).
  company      text,
  delivered_at timestamptz,
  delivery_error text
);
CREATE INDEX idx_public_site_alerts_created ON public_site_alerts (created_at DESC);
CREATE INDEX idx_public_site_alerts_ip_kind ON public_site_alerts (ip, kind, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public_site_alerts TO merchant_admin;
GRANT USAGE ON SEQUENCE public_site_alerts_alert_id_seq TO merchant_admin;
