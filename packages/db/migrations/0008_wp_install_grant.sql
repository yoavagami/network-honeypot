-- The WP install-takeover bait (apps/honeypot/src/routes/wpInstall.ts) creates a real
-- synthetic_objects "user" row from the live app when an actor completes the fake install —
-- previously only the superuser-run seed script ever wrote to this table. Scoped narrowly:
-- INSERT only, not UPDATE/DELETE, and only on this one table.
GRANT INSERT ON synthetic_objects TO honeypot_role;
