import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { migrateMerchantDb } from "./migrate.js";
import { createMerchantSql, type MerchantSql } from "./client.js";

/**
 * Integration-test helper: a fresh, migrated merchant database on the server named by
 * MERCHANT_TEST_PG_URL (a superuser URL, e.g. postgres://postgres@127.0.0.1:55433/postgres).
 * Tests that need it skip when the variable is unset, so `pnpm test` still runs anywhere.
 */
export const testPgUrl = process.env.MERCHANT_TEST_PG_URL;

export interface TestDatabase {
  owner: MerchantSql;
  app: MerchantSql;
  admin: MerchantSql;
  urls: { owner: string; app: string; admin: string };
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!testPgUrl) throw new Error("MERCHANT_TEST_PG_URL is not set");
  const name = `merchant_test_${randomBytes(4).toString("hex")}`;
  const base = new URL(testPgUrl);
  const ownerUrl = new URL(base.toString());
  ownerUrl.pathname = `/${name}`;
  const passwords = { app: "app_test_pw", admin: "admin_test_pw" };
  await migrateMerchantDb(ownerUrl.toString(), passwords, () => {});
  const roleUrl = (role: string, pw: string) => {
    const u = new URL(ownerUrl.toString());
    u.username = role;
    u.password = pw;
    return u.toString();
  };
  const urls = { owner: ownerUrl.toString(), app: roleUrl("merchant_app", passwords.app), admin: roleUrl("merchant_admin", passwords.admin) };
  const owner = createMerchantSql(urls.owner, 2);
  const app = createMerchantSql(urls.app, 5);
  const admin = createMerchantSql(urls.admin, 5);
  return {
    owner, app, admin, urls,
    async drop() {
      await Promise.all([owner.end(), app.end(), admin.end()]);
      const root = postgres(testPgUrl!, { max: 1, onnotice: () => {} });
      await root.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    },
  };
}
