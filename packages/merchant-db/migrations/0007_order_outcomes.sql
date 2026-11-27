-- Order outcomes (feedback) from more places than the merchant's server:
--   api        POST /v1/feedback (the merchant's server)
--   dashboard  set on the order page, by a merchant user or a uHoney admin (actor says which)
--   lab        recorded by uHoney for orders from its own verified lab runs: the run's kind (agent or
--              human) is known ground truth
ALTER TABLE feedback
  ADD COLUMN source text NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'dashboard', 'lab')),
  ADD COLUMN actor  text CHECK (char_length(actor) <= 200);

-- One lab outcome per assessment, so the worker can record them idempotently.
CREATE UNIQUE INDEX uq_feedback_lab ON feedback (assessment_id) WHERE source = 'lab';

-- The kind of each lab run, sent by admin-api (lab runs are created in the honeypot database, which
-- this service never reads). Not tenant data: merchant_admin only.
CREATE TABLE lab_run_kinds (
  label       text PRIMARY KEY CHECK (label ~ '^[A-Za-z0-9._-]{1,64}$'),
  kind        text NOT NULL CHECK (kind IN ('agent', 'human')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON lab_run_kinds TO merchant_admin;
