import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testPgUrl, type TestDatabase } from "../src/testing.js";
import { withMerchant } from "../src/client.js";

const A = "mer_AAAAAAA1";
const B = "mer_BBBBBBB2";

describe.skipIf(!testPgUrl)("merchant database row-level security", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    for (const m of [A, B]) {
      await db.admin`INSERT INTO merchants (merchant_id, status, company, website, contact_email) VALUES (${m}, 'approved', ${m}, 'https://x.test', 'a@x.test')`;
      await db.admin`INSERT INTO api_keys (merchant_id, kind, livemode, key_hash, display, created_by) VALUES (${m}, 'secret', false, ${"h_" + m}, 'sk_test_…', 'test')`;
      await db.admin`INSERT INTO merchant_events (merchant_id, livemode, session_id, kind) VALUES (${m}, false, gen_random_uuid(), 'page')`;
      await db.admin`INSERT INTO merchant_domains (merchant_id, host, verification_token) VALUES (${m}, 'shop.test', 'tok')`;
    }
  }, 60_000);
  afterAll(async () => { await db?.drop(); });

  it("a merchant transaction sees only its own rows", async () => {
    for (const table of ["merchants", "api_keys", "merchant_events", "merchant_domains"]) {
      const rows = await withMerchant(db.app, A, (tx) => tx.unsafe(`SELECT merchant_id FROM ${table}`));
      expect(rows.length, table).toBeGreaterThan(0);
      expect(rows.every((r: any) => r.merchant_id === A), table).toBe(true);
    }
  });

  it("without a merchant context, merchant_app sees nothing", async () => {
    const rows = await db.app`SELECT * FROM merchant_events`;
    expect(rows.length).toBe(0);
    const merchants = await db.app`SELECT * FROM merchants`;
    expect(merchants.length).toBe(0);
  });

  it("merchant_app cannot write rows for another merchant", async () => {
    await expect(withMerchant(db.app, A, (tx) => tx`INSERT INTO merchant_events (merchant_id, livemode, session_id, kind) VALUES (${B}, false, gen_random_uuid(), 'page')`)).rejects.toThrow(/row-level security/);
    const updated = await withMerchant(db.app, A, (tx) => tx`UPDATE merchant_domains SET host = 'evil.test' WHERE merchant_id = ${B} RETURNING 1`);
    expect(updated.length).toBe(0);
  });

  it("merchant_app cannot create or approve merchants directly", async () => {
    await expect(withMerchant(db.app, A, (tx) => tx`INSERT INTO merchants (merchant_id, company, website, contact_email) VALUES ('mer_CCCCCCC3', 'c', 'w', 'e@x.test')`)).rejects.toThrow(/permission denied/);
    await expect(withMerchant(db.app, A, (tx) => tx`UPDATE merchants SET status = 'approved'`)).rejects.toThrow(/permission denied/);
  });

  it("pre-tenant functions return only what each step needs", async () => {
    const [k] = await db.app`SELECT * FROM mk_lookup_key(${"h_" + B})`;
    expect(k).toMatchObject({ merchant_id: B, kind: "secret", livemode: false, revoked: false, merchant_status: "approved" });
    const none = await db.app`SELECT * FROM mk_lookup_key('nope')`;
    expect(none.length).toBe(0);
    const [id] = await db.app`SELECT mk_request_access('mer_DDDDDDD4', 'Co', 'https://co.test', 'Me@Co.Test', 'custom', '1k', null) AS id`;
    expect(id!.id).toBe("mer_DDDDDDD4");
    const [m] = await db.admin`SELECT status, contact_email FROM merchants WHERE merchant_id = 'mer_DDDDDDD4'`;
    expect(m).toMatchObject({ status: "pending", contact_email: "me@co.test" });
  });

  it("merchant_admin sees every merchant", async () => {
    const rows = await db.admin`SELECT DISTINCT merchant_id FROM merchant_events ORDER BY 1`;
    expect(rows.map((r) => r.merchant_id)).toEqual([A, B]);
  });

  it("a verified domain can belong to only one merchant", async () => {
    await db.admin`UPDATE merchant_domains SET verified_at = now() WHERE merchant_id = ${A}`;
    await expect(db.admin`UPDATE merchant_domains SET verified_at = now() WHERE merchant_id = ${B}`).rejects.toThrow(/uq_merchant_domains_verified_host/);
  });
});
