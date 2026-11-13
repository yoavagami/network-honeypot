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
 * Usage: pnpm create-superadmin [username] [--reset-password] [--role admin]
 *   (default username: superadmin; a new account defaults to role superadmin, a --reset-password
 *   keeps the account's existing role unless --role is given; --role admin creates a regular
 *   dashboard user with the same access as the seeded admin account)
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const args = process.argv.slice(2);
const resetPassword = args.includes("--reset-password");
const roleIdx = args.indexOf("--role");
// --role is optional. A new account defaults to superadmin; a password reset keeps the account's
// current role unless --role is given (it used to fall back to superadmin, which silently
// promoted a regular admin whose password was reset — found 2026-11-13).
const roleArg = roleIdx >= 0 ? args[roleIdx + 1] : undefined;
if (roleArg !== undefined && roleArg !== "admin" && roleArg !== "superadmin") throw new Error("--role must be admin or superadmin");
const username = args.find((a, i) => !a.startsWith("--") && (roleIdx < 0 || i !== roleIdx + 1)) ?? "superadmin";

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
    const role = (roleArg ?? existing.role) as "admin" | "superadmin";
    await db.update(schema.adminUsers).set({ passwordHash, role, disabled: false }).where(eq(schema.adminUsers.adminUserId, existing.adminUserId));
    // Rotating a password should end any session opened with the old one.
    await db.delete(schema.adminSessions).where(eq(schema.adminSessions.adminUserId, existing.adminUserId));
    console.log(`reset password for ${role} '${username}' and signed out its existing sessions`);
  } else {
    const role = (roleArg ?? "superadmin") as "admin" | "superadmin";
    await db.insert(schema.adminUsers).values({ adminUserId: randomUUID(), username, passwordHash, createdAt: new Date(), disabled: false, role });
    console.log(`created ${role} '${username}'`);
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
