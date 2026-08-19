import type postgres from "postgres";

/**
 * Idempotent, portable role provisioning — replaces relying on Postgres's
 * `docker-entrypoint-initdb.d` mechanism (infrastructure/docker/postgres-init/*), which only
 * works against a self-hosted Postgres container we control the image/entrypoint for. Managed
 * Postgres offerings (Render, RDS, Cloud SQL, etc.) never let you mount init scripts — they
 * hand you one owner/admin connection and nothing else — so role creation has to happen from
 * application-side SQL against that connection instead. This runs before migrations, from the
 * same `pnpm migrate` entrypoint, and is safe to re-run (CREATE ROLE ... IF NOT EXISTS doesn't
 * exist in Postgres, so we check pg_roles first).
 *
 * See docs/DEPLOYMENT.md for how this is used identically across a self-hosted VPS Postgres and
 * a managed Postgres instance.
 */
export async function ensureRoles(sql: postgres.Sql) {
  const honeypotPassword = requireEnv("HONEYPOT_DB_PASSWORD");
  const adminApiPassword = requireEnv("ADMIN_API_DB_PASSWORD");

  await ensureRole(sql, "honeypot_role", honeypotPassword);
  await ensureRole(sql, "admin_api_role", adminApiPassword);
}

async function ensureRole(sql: postgres.Sql, role: string, password: string) {
  const [existing] = await sql<{ rolname: string }[]>`SELECT rolname FROM pg_roles WHERE rolname = ${role}`;
  if (existing) {
    // Password may have rotated since the role was created — always resync it.
    await sql.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${escapeLiteral(password)}'`);
    console.log(`role exists, password resynced: ${role}`);
    return;
  }
  await sql.unsafe(`CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${escapeLiteral(password)}'`);
  console.log(`role created: ${role}`);
}

// Role names above are fixed string literals we control, not user input — this only escapes the
// password value being interpolated into an ALTER/CREATE ROLE statement, which the postgres.js
// tagged-template API doesn't support parameterizing for DDL.
function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
