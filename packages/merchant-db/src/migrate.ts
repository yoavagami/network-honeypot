import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Migrator for the merchant database (same hand-rolled approach as packages/db/src/migrate.ts).
 *
 *   MERCHANT_MIGRATE_URL         superuser connection to the merchant database
 *                                (e.g. postgres://honeypot_owner:…@postgres:5432/merchant)
 *   MERCHANT_APP_DB_PASSWORD     password for merchant_app   (public API + merchant dashboard)
 *   MERCHANT_ADMIN_DB_PASSWORD   password for merchant_admin (internal admin + workers)
 *
 * Creates the database if it is missing (connecting to the server's "postgres" database for
 * that), syncs both roles' passwords, then applies migrations/*.sql in order.
 */

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const requireEnv = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const ssl = (url: string) => (process.env.DATABASE_SSL === "true" || url.includes("sslmode=require") ? "require" : undefined);
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier ${s}`);
  return s;
};
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function ensureDatabase(url: string) {
  const u = new URL(url);
  const dbName = ident(decodeURIComponent(u.pathname.slice(1)));
  u.pathname = "/postgres";
  const admin = postgres(u.toString(), { max: 1, ssl: ssl(url), onnotice: () => {} });
  try {
    const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (!exists) {
      await admin.unsafe(`CREATE DATABASE ${dbName}`);
      console.log(`database created: ${dbName}`);
    }
  } finally {
    await admin.end();
  }
}

export async function ensureMerchantRoles(sql: postgres.Sql, passwords: { app: string; admin: string }) {
  for (const [role, pw] of [["merchant_app", passwords.app], ["merchant_admin", passwords.admin]] as const) {
    const [existing] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
    await sql.unsafe(existing
      ? `ALTER ROLE ${role} WITH LOGIN PASSWORD ${literal(pw)}`
      : `CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${literal(pw)}`);
  }
}

export async function migrateMerchantDb(url: string, passwords: { app: string; admin: string }, log: (m: string) => void = console.log) {
  await ensureDatabase(url);
  const sql = postgres(url, { max: 1, ssl: ssl(url), onnotice: () => {} });
  try {
    await ensureMerchantRoles(sql, passwords);
    await sql`CREATE TABLE IF NOT EXISTS _migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied = new Set((await sql<{ id: string }[]>`SELECT id FROM _migrations`).map((r) => r.id));
    for (const file of files) {
      if (applied.has(file)) continue;
      const contents = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(contents);
        await tx`INSERT INTO _migrations (id) VALUES (${file})`;
      });
      log(`applied: ${file}`);
    }
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrateMerchantDb(requireEnv("MERCHANT_MIGRATE_URL"), { app: requireEnv("MERCHANT_APP_DB_PASSWORD"), admin: requireEnv("MERCHANT_ADMIN_DB_PASSWORD") })
    .then(() => console.log("merchant database up to date"))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
