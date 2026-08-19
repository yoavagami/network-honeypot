import { describe, it, expect, beforeAll } from "vitest";
import postgres from "postgres";

/**
 * Integration test: exercises the real ingestion pipeline (HTTP -> hooks -> queue -> Postgres)
 * against a running stack, rather than mocking any part of it — the whole point of this
 * pipeline is the wiring between pieces, which unit tests on packages/detection intentionally
 * don't cover. Requires `docker compose up` (or the apps run directly) with DATABASE_URL
 * pointing at the same Postgres the honeypot app writes to. Skips if unreachable rather than
 * failing the whole suite, so `pnpm test` still works without the stack running.
 */

const HONEYPOT_URL = process.env.HONEYPOT_URL ?? "http://localhost:8080";
const DATABASE_URL = process.env.DATABASE_URL;

let reachable = false;
let sql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  try {
    const res = await fetch(`${HONEYPOT_URL}/health`, { signal: AbortSignal.timeout(2000) });
    reachable = res.ok;
    sql = postgres(DATABASE_URL, { max: 1 });
  } catch {
    reachable = false;
  }
});

describe.runIf(!!DATABASE_URL)("ingestion pipeline (integration)", () => {
  it("records a request row and an HTTP_REQUEST event for an ordinary GET", async () => {
    if (!reachable || !sql) return; // environment not up — see file header
    const marker = `it-${Date.now()}`;
    const res = await fetch(`${HONEYPOT_URL}/?marker=${marker}`, { headers: { "User-Agent": `vitest-integration/${marker}` } });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 800)); // allow the batch queue to flush

    const requests = await sql`select * from requests where query_string like ${"%" + marker + "%"}`;
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.status_code).toBe(200);

    const events = await sql`select * from events where actor_id = ${requests[0]!.actor_id} and event_type = 'HTTP_REQUEST' order by created_at desc limit 5`;
    expect(events.length).toBeGreaterThan(0);
  });

  it("flags a recon-signature path as HONEYPOT_TRIGGER with elevated risk", async () => {
    if (!reachable || !sql) return;
    const ua = `vitest-recon/${Date.now()}`;
    const res = await fetch(`${HONEYPOT_URL}/.env`, { headers: { "User-Agent": ua } });
    expect(res.status).toBe(404);

    await new Promise((r) => setTimeout(r, 800));

    const requests = await sql`select * from requests where user_agent_raw = ${ua}`;
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]!.risk_score).toBeGreaterThan(0);

    const events = await sql`select event_type from events where actor_id = ${requests[0]!.actor_id} and event_type = 'HONEYPOT_TRIGGER'`;
    expect(events.length).toBeGreaterThan(0);
  });

  it("never persists a raw password anywhere in the requests table", async () => {
    if (!reachable || !sql) return;
    const secret = `S3cretPassw0rd_${Date.now()}`;
    await fetch(`${HONEYPOT_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nobody", password: secret }),
    });

    await new Promise((r) => setTimeout(r, 800));

    const rows = await sql`select * from requests where path = '/login' order by created_at desc limit 1`;
    expect(rows.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(secret);
  });
});
