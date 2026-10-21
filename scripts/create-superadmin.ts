import { randomUUID, randomBytes } from "node:crypto";
import argon2 from "argon2";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { schema } from "@honeypot/db";

/**
 * Creates the superadmin dashboard account (role 'superadmin' — see
 * packages/db/migrations/0009_admin_roles.sql), or with --reset-password rotates its password.
 * The password is generated, printed once, and stored only as an Argon2id hash — same handling
 * as seed.ts's admin account.
 *
 * Usage: pnpm create-superadmin [username] [--reset-password]   (default username: superadmin)
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const args = process.argv.slice(2);
const resetPassword = args.includes("--reset-password");
const username = args.find((a) => !a.startsWith("--")) ?? "superadmin";

const requiresSsl = process.env.DATABASE_SSL === "true" || connectionString.includes("sslmode=require");
const client = postgres(connectionString, { max: 1, ssl: requiresSsl ? "require" : undefined });
const db = drizzle(client, { schema });

async function main() {
  const password = randomBytes(18).toString("hex");
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const [existing] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.username, username)).limit(1);

  if (existing && !resetPassword) {
    console.log(`account '${username}' already exists (role: ${existing.role}) — rerun with --reset-password to rotate its password`);
    return;
  }

  if (existing) {
    await db.update(schema.adminUsers).set({ passwordHash, role: "superadmin", disabled: false }).where(eq(schema.adminUsers.adminUserId, existing.adminUserId));
    // Rotating a password should end any session opened with the old one.
    await db.delete(schema.adminSessions).where(eq(schema.adminSessions.adminUserId, existing.adminUserId));
    console.log(`reset password for superadmin '${username}' and signed out its existing sessions`);
  } else {
    await db.insert(schema.adminUsers).values({ adminUserId: randomUUID(), username, passwordHash, createdAt: new Date(), disabled: false, role: "superadmin" });
    console.log(`created superadmin '${username}'`);
  }
  console.log(`  username: ${username}`);
  console.log(`  password: ${password}  (save this now — it is not stored anywhere else)`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => client.end());
