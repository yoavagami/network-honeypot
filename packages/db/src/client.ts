import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export interface CreateDbClientOptions {
  connectionString: string;
  /** Max pool size — kept modest per-service; see docs/ARCHITECTURE.md §14. */
  max?: number;
}

/**
 * Each service (honeypot app, admin-api) calls this with its own scoped-role connection
 * string (honeypot_role / admin_api_role) — never a superuser connection. See
 * docs/SECURITY.md §3 and the GRANTs in migrations/0001_init.sql.
 */
export function createDbClient({ connectionString, max = 10 }: CreateDbClientOptions) {
  // Managed Postgres reached over the public internet (e.g. Render's external connection string,
  // used when running admin-api locally against Render-hosted Postgres — see
  // docs/DEPLOY_RENDER.md) requires TLS. DATABASE_SSL=true forces it explicitly rather than
  // relying on sslmode= being parsed correctly out of every possible connection string shape.
  const requiresSsl = process.env.DATABASE_SSL === "true" || connectionString.includes("sslmode=require");
  const client = postgres(connectionString, { max, ssl: requiresSsl ? "require" : undefined });
  const db = drizzle(client, { schema });
  return { db, client };
}

export type DbClient = ReturnType<typeof createDbClient>["db"];
export { schema };
