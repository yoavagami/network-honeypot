#!/usr/bin/env bash
# Sets passwords for the scoped roles from environment variables injected by docker-compose
# (never hardcoded, never committed). Runs as part of the official postgres image's
# docker-entrypoint-initdb.d mechanism.
set -euo pipefail

: "${HONEYPOT_DB_PASSWORD:?HONEYPOT_DB_PASSWORD must be set}"
: "${ADMIN_API_DB_PASSWORD:?ADMIN_API_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  ALTER ROLE honeypot_role WITH PASSWORD '${HONEYPOT_DB_PASSWORD}';
  ALTER ROLE admin_api_role WITH PASSWORD '${ADMIN_API_DB_PASSWORD}';
EOSQL
