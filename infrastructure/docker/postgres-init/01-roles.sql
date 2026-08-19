-- Scoped, least-privilege roles per service. See docs/ARCHITECTURE.md §3 and docs/SECURITY.md §3.
-- Passwords are supplied via environment substitution at container init time (see
-- infrastructure/docker/postgres-init/entrypoint wrapper / docker-compose.yml) rather than
-- hardcoded here. This file creates the roles with placeholder passwords that docker-compose
-- immediately overrides via ALTER ROLE using env-sourced values (00-passwords.sh runs after this).

CREATE ROLE honeypot_role LOGIN;
CREATE ROLE admin_api_role LOGIN;

-- Neither scoped role can create new roles/databases or bypass RLS.
ALTER ROLE honeypot_role NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE admin_api_role NOSUPERUSER NOCREATEDB NOCREATEROLE;
