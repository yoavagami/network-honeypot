-- Merchant platform, v1 (docs/merchant/CONTRACT.md). Lives in its own database ("merchant"), apart
-- from the honeypot's: lab and attack traffic never mixes with a customer's data.
--
-- Isolation is enforced twice. In code, apps/merchant-api runs every tenant query inside
-- withMerchant(), which sets app.merchant_id for that transaction from the session or API key —
-- never from a request parameter. Here, row-level security limits merchant_app to that merchant's
-- rows, so a missed filter in code returns nothing instead of another merchant's data.
--
--   merchant_app    public API + merchant dashboard. Sees one merchant per transaction.
--   merchant_admin  internal admin endpoints + the scoring/webhook workers. Sees all merchants.
--
-- The few lookups that happen before the merchant is known (API key, login, invite, request
-- access) are SECURITY DEFINER functions that return only what that step needs.

CREATE OR REPLACE FUNCTION current_merchant() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.merchant_id', true), '') $$;

CREATE TABLE merchants (
  merchant_id        text PRIMARY KEY CHECK (merchant_id ~ '^mer_[0-9A-HJKMNP-TV-Z]{8}$'),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'suspended')),
  company            text NOT NULL CHECK (length(company) BETWEEN 1 AND 200),
  website            text NOT NULL CHECK (length(website) BETWEEN 1 AND 255),
  contact_email      text NOT NULL CHECK (length(contact_email) BETWEEN 3 AND 254),
  platform           text NOT NULL DEFAULT 'custom' CHECK (platform IN ('custom', 'shopify', 'woocommerce', 'other')),
  monthly_checkouts  text,
  policy             jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention_days     integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 7 AND 400),
  request_ip_hash    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  reviewed_at        timestamptz,
  reviewed_by        text
);
CREATE INDEX idx_merchants_status ON merchants (status, created_at DESC);

CREATE TABLE merchant_users (
  user_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  email          text NOT NULL CHECK (email = lower(email)),
  name           text NOT NULL DEFAULT '',
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('owner', 'developer', 'analyst')),
  disabled       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);
-- One login per email address across the platform: an email belongs to one merchant.
CREATE UNIQUE INDEX uq_merchant_users_email ON merchant_users (email);
CREATE INDEX idx_merchant_users_merchant ON merchant_users (merchant_id);

CREATE TABLE merchant_invites (
  token_hash   text PRIMARY KEY,
  merchant_id  text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  email        text NOT NULL CHECK (email = lower(email)),
  role         text NOT NULL CHECK (role IN ('owner', 'developer', 'analyst')),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);
CREATE INDEX idx_merchant_invites_merchant ON merchant_invites (merchant_id, created_at DESC);

CREATE TABLE merchant_user_sessions (
  session_hash  text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES merchant_users ON DELETE CASCADE,
  merchant_id   text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  csrf_token    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX idx_merchant_sessions_user ON merchant_user_sessions (user_id);

CREATE TABLE api_keys (
  key_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('public', 'secret')),
  livemode      boolean NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  -- Public keys are public: kept in full so the dashboard can show the tag snippet.
  public_value  text CHECK ((kind = 'public') = (public_value IS NOT NULL)),
  -- Secret keys: shown once, then only "sk_test_…a91F".
  display       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX idx_api_keys_merchant ON api_keys (merchant_id, kind, livemode);

CREATE TABLE merchant_domains (
  domain_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id         text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  host                text NOT NULL CHECK (host ~ '^[a-z0-9.-]{1,253}$'),
  verification_token  text NOT NULL,
  verified_at         timestamptz,
  verified_method     text CHECK (verified_method IN ('dns', 'meta')),
  last_checked_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, host)
);
-- A verified domain belongs to exactly one merchant.
CREATE UNIQUE INDEX uq_merchant_domains_verified_host ON merchant_domains (host) WHERE verified_at IS NOT NULL;

CREATE TABLE webhook_endpoints (
  endpoint_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  livemode          boolean NOT NULL,
  url               text NOT NULL CHECK (url ~ '^https://'),
  -- AES-256-GCM with MERCHANT_ENCRYPTION_KEY (apps/merchant-api/src/crypto.ts): we need the
  -- plaintext to sign deliveries, so it can't be a one-way hash.
  secret_encrypted  text NOT NULL,
  secret_display    text NOT NULL,
  events            text[] NOT NULL DEFAULT ARRAY['assessment.updated', 'checkout.agent_started'],
  created_at        timestamptz NOT NULL DEFAULT now(),
  disabled_at       timestamptz
);
CREATE INDEX idx_webhook_endpoints_merchant ON webhook_endpoints (merchant_id, livemode);

CREATE TABLE webhook_deliveries (
  event_id         text PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9]{20}$'),
  merchant_id      text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints ON DELETE CASCADE,
  livemode         boolean NOT NULL,
  type             text NOT NULL,
  payload          jsonb NOT NULL,
  is_test          boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_status      integer,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz
);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_webhook_deliveries_merchant ON webhook_deliveries (merchant_id, livemode, created_at DESC);

-- Everything the tag and the assess call tell us, one row per beacon / call.
CREATE TABLE merchant_events (
  event_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  livemode         boolean NOT NULL,
  session_id       uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('page', 'event', 'fp', 'behavior', 'probe', 'assess')),
  name             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  page_view_id     text,
  path             text,
  origin           text,
  -- Raw IP kept only until the visit is scored and the retention job clears it (24 h); the hash
  -- (keyed, per merchant) stays for grouping.
  ip               inet,
  ip_hash          text,
  user_agent       text,
  accept_language  text,
  identity         jsonb,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_merchant_events_session ON merchant_events (merchant_id, livemode, session_id, created_at);
CREATE INDEX idx_merchant_events_recent ON merchant_events (merchant_id, livemode, created_at DESC);
CREATE INDEX idx_merchant_events_created ON merchant_events (created_at);

CREATE TABLE merchant_visits (
  visit_id                  text PRIMARY KEY CHECK (visit_id ~ '^vis_[A-Za-z0-9]{20}$'),
  merchant_id               text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  livemode                  boolean NOT NULL,
  session_id                uuid NOT NULL,
  first_at                  timestamptz NOT NULL,
  last_at                   timestamptz NOT NULL,
  settled                   boolean NOT NULL DEFAULT false,
  computed_at               timestamptz NOT NULL,
  scorer_version            text NOT NULL,
  probability               real NOT NULL,
  bucket                    text NOT NULL,
  type                      text NOT NULL,
  agent                     text,
  proven                    boolean NOT NULL DEFAULT false,
  driver                    text NOT NULL,
  handover                  jsonb,
  reasons                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  page_count                integer NOT NULL DEFAULT 0,
  reached_checkout          boolean NOT NULL DEFAULT false,
  reached_pay               boolean NOT NULL DEFAULT false,
  agent_checkout_notified   boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_merchant_visits_list ON merchant_visits (merchant_id, livemode, last_at DESC);
CREATE INDEX idx_merchant_visits_session ON merchant_visits (merchant_id, livemode, session_id);
CREATE INDEX idx_merchant_visits_open ON merchant_visits (last_at) WHERE NOT settled;

CREATE TABLE assessments (
  assessment_id    text PRIMARY KEY CHECK (assessment_id ~ '^as_[A-Za-z0-9]{20}$'),
  merchant_id      text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  livemode         boolean NOT NULL,
  idempotency_key  text NOT NULL,
  request_hash     text NOT NULL,
  session_id       uuid,
  visit_id         text,
  order_id         text NOT NULL,
  amount           bigint NOT NULL,
  currency         text NOT NULL,
  token_status     text NOT NULL CHECK (token_status IN ('valid', 'missing', 'invalid')),
  header_count     integer NOT NULL DEFAULT 0,
  server_ms        integer NOT NULL,
  response         jsonb NOT NULL,
  final            boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, livemode, idempotency_key)
);
CREATE INDEX idx_assessments_list ON assessments (merchant_id, livemode, created_at DESC);
CREATE INDEX idx_assessments_order ON assessments (merchant_id, livemode, order_id);
CREATE INDEX idx_assessments_open ON assessments (created_at) WHERE NOT final;

CREATE TABLE feedback (
  feedback_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  livemode       boolean NOT NULL,
  assessment_id  text NOT NULL REFERENCES assessments ON DELETE CASCADE,
  order_id       text NOT NULL,
  outcome        text NOT NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_feedback_assessment ON feedback (assessment_id);

CREATE TABLE merchant_audit (
  audit_id     bigserial PRIMARY KEY,
  merchant_id  text REFERENCES merchants ON DELETE CASCADE,
  actor        text NOT NULL,
  action       text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_merchant_audit_merchant ON merchant_audit (merchant_id, created_at DESC);

-- ---------------------------------------------------------------- row-level security

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['merchants', 'merchant_users', 'merchant_invites', 'merchant_user_sessions', 'api_keys',
    'merchant_domains', 'webhook_endpoints', 'webhook_deliveries', 'merchant_events', 'merchant_visits',
    'assessments', 'feedback', 'merchant_audit']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO merchant_app USING (merchant_id = current_merchant()) WITH CHECK (merchant_id = current_merchant())', t);
    EXECUTE format('CREATE POLICY admin_all ON %I TO merchant_admin USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- grants

GRANT USAGE ON SCHEMA public TO merchant_app, merchant_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO merchant_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO merchant_app, merchant_admin;

-- merchant_app: its merchant row is read/update only (no creating or deleting merchants).
GRANT SELECT, UPDATE (policy, retention_days) ON merchants TO merchant_app;
GRANT SELECT, INSERT, UPDATE ON merchant_users, merchant_invites, api_keys, merchant_domains, webhook_endpoints, webhook_deliveries, merchant_visits, assessments TO merchant_app;
GRANT DELETE ON merchant_domains, webhook_endpoints TO merchant_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON merchant_user_sessions TO merchant_app;
GRANT SELECT, INSERT ON merchant_events, feedback, merchant_audit TO merchant_app;

-- ---------------------------------------------------------------- pre-tenant lookups

-- API key → merchant. Only the fields the caller needs; never the hash of another key.
CREATE FUNCTION mk_lookup_key(p_hash text)
RETURNS TABLE (key_id uuid, merchant_id text, kind text, livemode boolean, revoked boolean, merchant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT k.key_id, k.merchant_id, k.kind, k.livemode, k.revoked_at IS NOT NULL, m.status
  FROM api_keys k JOIN merchants m USING (merchant_id)
  WHERE k.key_hash = p_hash
$$;

CREATE FUNCTION mk_login_lookup(p_email text)
RETURNS TABLE (user_id uuid, merchant_id text, password_hash text, role text, disabled boolean, merchant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.user_id, u.merchant_id, u.password_hash, u.role, u.disabled, m.status
  FROM merchant_users u JOIN merchants m USING (merchant_id)
  WHERE u.email = lower(p_email)
$$;

CREATE FUNCTION mk_session_lookup(p_hash text)
RETURNS TABLE (user_id uuid, merchant_id text, csrf_token text, last_seen_at timestamptz, expires_at timestamptz,
               email text, name text, role text, disabled boolean, merchant_status text, company text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.user_id, s.merchant_id, s.csrf_token, s.last_seen_at, s.expires_at, u.email, u.name, u.role, u.disabled, m.status, m.company
  FROM merchant_user_sessions s
  JOIN merchant_users u USING (user_id)
  JOIN merchants m ON m.merchant_id = s.merchant_id
  WHERE s.session_hash = p_hash
$$;

CREATE FUNCTION mk_invite_lookup(p_hash text)
RETURNS TABLE (merchant_id text, email text, role text, company text, expires_at timestamptz, used boolean, merchant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.merchant_id, i.email, i.role, m.company, i.expires_at, i.used_at IS NOT NULL, m.status
  FROM merchant_invites i JOIN merchants m USING (merchant_id)
  WHERE i.token_hash = p_hash
$$;

-- Request access: the only way merchant_app can create a merchant, always as 'pending'.
CREATE FUNCTION mk_request_access(p_merchant_id text, p_company text, p_website text, p_email text, p_platform text, p_monthly text, p_ip_hash text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO merchants (merchant_id, status, company, website, contact_email, platform, monthly_checkouts, request_ip_hash)
  VALUES (p_merchant_id, 'pending', p_company, p_website, lower(p_email), p_platform, p_monthly, p_ip_hash);
  INSERT INTO merchant_audit (merchant_id, actor, action, detail) VALUES (p_merchant_id, 'public', 'merchant.requested', jsonb_build_object('platform', p_platform));
  RETURN p_merchant_id;
END $$;

-- Is this email already a user anywhere? (invite acceptance must not leak which merchant)
CREATE FUNCTION mk_email_taken(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM merchant_users WHERE email = lower(p_email))
$$;

REVOKE ALL ON FUNCTION mk_lookup_key(text), mk_login_lookup(text), mk_session_lookup(text), mk_invite_lookup(text),
  mk_request_access(text, text, text, text, text, text, text), mk_email_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mk_lookup_key(text), mk_login_lookup(text), mk_session_lookup(text), mk_invite_lookup(text),
  mk_request_access(text, text, text, text, text, text, text), mk_email_taken(text) TO merchant_app, merchant_admin;
