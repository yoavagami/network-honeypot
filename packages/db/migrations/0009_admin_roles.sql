-- Admin roles. 'admin' is the existing, shareable dashboard account; 'superadmin' can also see
-- the dashboard's own access log (GET /api/access-log). Every existing account stays 'admin'.
-- The role is enforced server-side in apps/admin-api/src/middleware.ts (requireSuperadmin);
-- hiding the nav link in admin-web is cosmetic only.
ALTER TABLE admin_users
  ADD COLUMN role text NOT NULL DEFAULT 'admin'
  CHECK (role IN ('admin', 'superadmin'));
