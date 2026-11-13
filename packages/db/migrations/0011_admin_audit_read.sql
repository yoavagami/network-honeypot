-- The superadmin Access Log (apps/admin-api/src/routes/accessLog.ts) shows which account each
-- dashboard login was for, from the login / login_failed audit rows. admin_api_role gets
-- SELECT only: the audit log stays append-only for it (no UPDATE / DELETE), so it still can't
-- rewrite or erase its own history. The route itself is superadmin-only.
GRANT SELECT ON admin_audit_log TO admin_api_role;
