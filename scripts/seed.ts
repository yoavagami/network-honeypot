import { randomUUID, randomBytes } from "node:crypto";
import argon2 from "argon2";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "@honeypot/db";

/**
 * Seeds fully synthetic content: fake users, documents/invoices, canary objects, and (if not
 * already present) an admin user. Everything here is fabricated — see docs/PRIVACY.md and
 * docs/THREAT_MODEL.md §6. Run with a superuser/owner DATABASE_URL (not a scoped app role),
 * since it writes to admin_users which app roles cannot.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

// Same TLS detection as migrate.ts / client.ts's createDbClient — managed Postgres reached over
// the public internet (Render, RDS, ...) requires it; self-hosted Postgres never has, which is
// why this went unnoticed until seeding against Render's DB actually failed.
const requiresSsl = process.env.DATABASE_SSL === "true" || connectionString.includes("sslmode=require");
const client = postgres(connectionString, { max: 1, ssl: requiresSsl ? "require" : undefined });
const db = drizzle(client, { schema });

const SYNTHETIC_NAMES = [
  ["Alice Chen", "alice"],
  ["Ben Torres", "btorres"],
  ["Priya Nair", "pnair"],
  ["Sam Okafor", "sokafor"],
  ["Jordan Lee", "jlee"],
  ["Maria Silva", "msilva"],
  ["Tom Becker", "tbecker"],
  ["Yuki Tanaka", "ytanaka"],
] as const;

const WEAK_PASSWORDS = ["Summer2024!", "Password123", "meridian2023", "Welcome1!", "changeme99", "Qwerty123!", "Spring2025#", "letmein42"];

async function seedUsers() {
  for (let i = 0; i < SYNTHETIC_NAMES.length; i++) {
    const [name, username] = SYNTHETIC_NAMES[i]!;
    const email = `${username}@meridian.example`;
    const password = WEAK_PASSWORDS[i % WEAK_PASSWORDS.length]!;
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const publicRef = String(1000 + i);
    const apiKeyPreview = `hp_sk_${randomBytes(4).toString("hex")}...`;

    await db
      .insert(schema.syntheticObjects)
      .values({
        objectId: randomUUID(),
        objectType: "user",
        publicRef,
        data: { username, email, name, passwordHash, apiKeyPreview, publicApiFields: { role: i === 0 ? "owner" : "member" } },
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  }
  console.log(`seeded ${SYNTHETIC_NAMES.length} synthetic users`);
}

async function seedDocuments() {
  const docs = [
    { title: "Q1 Roadmap.pdf", kind: "document" },
    { title: "Invoice #4471 - Acme Co", kind: "invoice", amount: 4200 },
    { title: "Invoice #4472 - Globex", kind: "invoice", amount: 1899 },
    { title: "Vendor Agreement - Northwind.docx", kind: "document" },
    { title: "Client Onboarding Checklist", kind: "document" },
    { title: "Invoice #4473 - Initech", kind: "invoice", amount: 950 },
  ];
  for (let i = 0; i < docs.length; i++) {
    await db
      .insert(schema.syntheticObjects)
      .values({
        objectId: randomUUID(),
        objectType: "document",
        publicRef: String(2000 + i),
        data: docs[i],
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  }
  console.log(`seeded ${docs.length} synthetic documents`);
}

async function seedCanaries() {
  const canaries: Array<{ canaryType: "api_key" | "internal_url" | "token" | "credential" | "object_id"; value: string; plantedLocation: string }> = [
    { canaryType: "api_key", value: `hp_pk_live_${randomBytes(12).toString("hex")}`, plantedLocation: "GET /api/v1/config" },
    { canaryType: "internal_url", value: "int-billing-01.meridian.internal", plantedLocation: "GET /docs (HTML comment)" },
    { canaryType: "token", value: `hp_admin_tok_${randomBytes(12).toString("hex")}`, plantedLocation: "GET /api/v1/admin/config" },
  ];
  for (const c of canaries) {
    await db.insert(schema.canaryObjects).values({ canaryId: randomUUID(), ...c, createdAt: new Date(), active: true }).onConflictDoNothing();
  }
  console.log(`seeded ${canaries.length} canaries`);
}

async function seedAdmin() {
  const username = process.env.SEED_ADMIN_USERNAME ?? "admin";
  const existing = await db.select().from(schema.adminUsers).limit(1);
  if (existing.length > 0) {
    console.log("admin user already exists — skipping");
    return;
  }
  const password = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(12).toString("base64url");
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await db.insert(schema.adminUsers).values({
    adminUserId: randomUUID(),
    username,
    passwordHash,
    createdAt: new Date(),
    disabled: false,
  });
  console.log("seeded admin user:");
  console.log(`  username: ${username}`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log(`  password: ${password}  (generated — save this now, it is not stored anywhere else)`);
  } else {
    console.log("  password: (from SEED_ADMIN_PASSWORD)");
  }
}

async function main() {
  await seedUsers();
  await seedDocuments();
  await seedCanaries();
  await seedAdmin();
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
