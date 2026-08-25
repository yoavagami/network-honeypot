-- Adversarial review (docs/VULNERABILITY.md) found that postgres.js's `.unsafe()` executes
-- stacked statements (search=x'; SELECT pg_sleep(300); --), which GRANTs can't prevent since
-- pg_sleep isn't a write. Real GRANTs stop data modification/exfiltration beyond the six crm_*
-- tables; this stops the remaining resource-exhaustion angle (tying up the small CRM connection
-- pool) the same way a real production DB would — a statement timeout, not a code-level guess at
-- "this looks like an injection attempt."
ALTER ROLE honeypot_crm_role SET statement_timeout = '5s';
