import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Hand-rolled SQL migrator. We don't use drizzle-kit's generator here because the schema
 * relies on native Postgres declarative partitioning (PARTITION BY RANGE) and DO-block driven
 * partition creation, which drizzle-kit's diffing doesn't model well. Migrations are plain,
 * reviewable SQL files applied in filename order, tracked in `_migrations`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to run migrations");

  const sql = postgres(connectionString, { max: 1 });
  try {
    await sql`CREATE TABLE IF NOT EXISTS _migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied = new Set((await sql<{ id: string }[]>`SELECT id FROM _migrations`).map((r) => r.id));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip (already applied): ${file}`);
        continue;
      }
      const contents = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`applying: ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(contents);
        await tx`INSERT INTO _migrations (id) VALUES (${file})`;
      });
      console.log(`applied: ${file}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
