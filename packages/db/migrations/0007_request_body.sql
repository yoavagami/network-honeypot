-- General request body capture — see apps/honeypot/src/ingestion/capture.ts and
-- apps/honeypot/src/bodyRedaction.ts. Never populated for credential-bearing routes
-- (/login, /register, /reset-password, /admin/login — see EXCLUDED_BODY_PATHS); for every other
-- route, any field whose key looks sensitive (password/token/secret/api_key/...) has its value
-- redacted before storage. requests is a partitioned table — ALTER TABLE on the parent
-- propagates to all existing and future monthly partitions automatically.
ALTER TABLE requests ADD COLUMN request_body jsonb;
