-- Server-side admin session store (instant revocation, unlike a bare JWT) — see
-- docs/SECURITY.md §2. Owned entirely by admin_api_role; the honeypot app has no access.
CREATE TABLE admin_sessions (
  admin_session_id text PRIMARY KEY,
  admin_user_id    uuid NOT NULL REFERENCES admin_users (admin_user_id) ON DELETE CASCADE,
  csrf_token       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  ip_hash          text
);
CREATE INDEX idx_admin_sessions_user ON admin_sessions (admin_user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON admin_sessions TO admin_api_role;
