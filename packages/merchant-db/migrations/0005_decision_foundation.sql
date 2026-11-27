-- Foundations for the legitimacy and intent layers (assess returns a decision; intents, a decision
-- history and evidence records get their tables). This migration adds no new behaviour on its
-- own: the decision maps from suggested_action, and nothing writes intents or evidence yet.

-- ---------------------------------------------------------------- assessments

-- decision: allow | confirm | block. confirm is the default ceiling; block only when the
-- merchant's policy opts in (policy.block_when). intent_ref: the intent the merchant named at
-- assess, resolved by a later release.
ALTER TABLE assessments
  ADD COLUMN decision   text CHECK (decision IN ('allow', 'confirm', 'block')),
  ADD COLUMN intent_ref text CHECK (char_length(intent_ref) <= 128);

-- Existing assessments get the fields every response now carries.
UPDATE assessments SET
  decision = CASE response->>'suggested_action' WHEN 'allow' THEN 'allow' ELSE 'confirm' END,
  response = response || jsonb_build_object(
    'decision', CASE response->>'suggested_action' WHEN 'allow' THEN 'allow' ELSE 'confirm' END,
    'legitimacy', jsonb_build_object('evaluated', false, 'score', NULL, 'reasons', '[]'::jsonb),
    'intent', jsonb_build_object('status', 'not_provided', 'score', NULL, 'violations', '[]'::jsonb),
    'evidence_id', NULL)
WHERE decision IS NULL;

-- ---------------------------------------------------------------- intents

-- What the shopper asked for, in one internal shape whatever the source: a signed mandate, a
-- Verifiable-Intent-style record, a task the agent declared, or one the merchant recorded.
-- constraints: hard limits (max amount, currency, merchant, items or categories, quantity,
-- expiry, shipping country). task: the shopper's request in their words, if declared.
CREATE TABLE intents (
  intent_id    text PRIMARY KEY CHECK (intent_id ~ '^in_[A-Za-z0-9]{20}$'),
  merchant_id  text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  livemode     boolean NOT NULL,
  session_id   uuid,
  source       text NOT NULL CHECK (source IN ('mandate', 'verifiable_intent', 'agent_declared', 'merchant')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'expired', 'revoked')),
  constraints  jsonb NOT NULL DEFAULT '{}'::jsonb,
  task         text CHECK (char_length(task) <= 2000),
  issuer       text,
  verified     boolean NOT NULL DEFAULT false,
  raw_hash     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX idx_intents_session ON intents (merchant_id, livemode, session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_intents_created ON intents (created_at);

-- ---------------------------------------------------------------- decisions

-- Every decision returned for an assessment: the first at Pay, then each change the scoring
-- worker makes. The assessment row holds the latest; this is the history for the evidence view.
CREATE TABLE decisions (
  decision_id       bigserial PRIMARY KEY,
  merchant_id       text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  livemode          boolean NOT NULL,
  assessment_id     text NOT NULL REFERENCES assessments ON DELETE CASCADE,
  order_id          text NOT NULL,
  decision          text NOT NULL CHECK (decision IN ('allow', 'confirm', 'block')),
  suggested_action  text NOT NULL,
  legitimacy_score  real,
  intent_status     text NOT NULL,
  intent_score      real,
  reasons           jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy            jsonb NOT NULL DEFAULT '{}'::jsonb,
  scorer_version    text NOT NULL,
  final             boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_decisions_assessment ON decisions (assessment_id, created_at);
CREATE INDEX idx_decisions_created ON decisions (created_at);

-- ---------------------------------------------------------------- evidence

-- Append-only, hash-chained record per order: each entry_hash covers the entry and the previous
-- entry's hash, so changing or removing an earlier entry breaks every later one. Rows can't be
-- updated (trigger below); the retention job may delete whole orders' records once they expire.
CREATE TABLE evidence_entries (
  entry_id       bigserial PRIMARY KEY,
  merchant_id    text NOT NULL REFERENCES merchants ON DELETE CASCADE,
  livemode       boolean NOT NULL,
  order_id       text NOT NULL,
  assessment_id  text REFERENCES assessments ON DELETE SET NULL,
  seq            integer NOT NULL CHECK (seq >= 0),
  kind           text NOT NULL,
  payload        jsonb NOT NULL,
  payload_hash   text NOT NULL,
  prev_hash      text,
  entry_hash     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, livemode, order_id, seq)
);
CREATE INDEX idx_evidence_created ON evidence_entries (created_at);

CREATE FUNCTION evidence_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evidence entries are append-only';
END $$;
CREATE TRIGGER evidence_entries_no_update BEFORE UPDATE ON evidence_entries
  FOR EACH ROW EXECUTE FUNCTION evidence_entries_immutable();

-- ---------------------------------------------------------------- row-level security, grants

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intents', 'decisions', 'evidence_entries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO merchant_app USING (merchant_id = current_merchant()) WITH CHECK (merchant_id = current_merchant())', t);
    EXECUTE format('CREATE POLICY admin_all ON %I TO merchant_admin USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON intents, decisions, evidence_entries TO merchant_admin;
GRANT SELECT, INSERT, UPDATE ON intents TO merchant_app;
GRANT SELECT, INSERT ON decisions, evidence_entries TO merchant_app;
GRANT USAGE ON SEQUENCE decisions_decision_id_seq, evidence_entries_entry_id_seq TO merchant_app, merchant_admin;
