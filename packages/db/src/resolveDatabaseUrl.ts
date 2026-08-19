/**
 * Resolves the connection string a service uses to reach Postgres. Prefers `DATABASE_URL`
 * directly (the simple path for local dev and a self-hosted VPS, where we control the whole
 * connection string). Falls back to composing one from `PGHOST`/`PGPORT`/`PGDATABASE` plus a
 * role-specific password env var — this is the shape a managed Postgres provider (Render, RDS,
 * Cloud SQL) actually gives you: host/port/database for the instance, but never a
 * pre-built connection string for a *scoped* role you create yourself (see ensureRoles.ts). See
 * docs/DEPLOY_RENDER.md.
 */
export function resolveDatabaseUrl(role: string, passwordEnvVar: string): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = requireEnv("PGHOST");
  const port = process.env.PGPORT ?? "5432";
  const database = requireEnv("PGDATABASE");
  const password = requireEnv(passwordEnvVar);

  return `postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (or set DATABASE_URL directly)`);
  return value;
}
