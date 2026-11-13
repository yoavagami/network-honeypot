/**
 * `pnpm --filter @honeypot/app-honeypot export-fixture <visitId> [name]` — writes a real (lab) visit
 * as a redacted golden fixture to packages/detection/test/fixtures/visits/<name>.json, with the
 * current verdict as its expectation. Review the expectation before committing: the fixture
 * should pin the verdict the visit *ought* to get. See packages/detection/test/goldenVisits.test.ts.
 *
 * Redaction (packages/detection/src/fixtureRedaction.ts — the repo is public): no IPs, ids, cookies
 * or lab tokens are in VisitEvidence to begin with; the device fingerprint is cut down to what the
 * scorer reads, with canvas/GPU values replaced by placeholders, and query strings dropped.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVisits, redactFixtureEvidence, scoreVisit, visitEvidence } from "@honeypot/detection";
import { loadVisitRows } from "@honeypot/db";
import { client } from "../db.js";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/detection/test/fixtures/visits");

async function main() {
  const [id, nameArg] = process.argv.slice(2);
  const m = /^([sa])_([0-9a-f-]{36})_(\d+)$/.exec(id ?? "");
  if (!m) throw new Error("usage: export-fixture <visitId> [name]");
  const start = Number(m[3]);
  const rows = await loadVisitRows(client, { since: new Date(start - 1000), until: new Date(start + 24 * 3600_000), ...(m[1] === "s" ? { sessionId: m[2]! } : { actorIds: [m[2]!] }) });
  const v = buildVisits(rows.requests, rows.client, rows.shop).find((x) => x.id === id);
  if (!v) throw new Error(`visit ${id} not found`);
  const ev = redactFixtureEvidence(visitEvidence(v));
  const s = scoreVisit(ev);
  const lab = v.requests.find((r) => r.lab_label)?.lab_label ?? null;
  const name = (nameArg ?? lab ?? `visit-${start}`).replace(/[^a-z0-9.-]/gi, "-").toLowerCase();
  const fixture = {
    name,
    source: "lab-export",
    description: `Exported ${new Date().toISOString().slice(0, 10)} from ${lab ? `lab run ${lab}` : "an unlabeled visit"}${v.requests.some((r) => r.lab_verified) ? " (signed)" : ""}. Check the expectation.`,
    expect: { bucket: s.bucket, type: s.type, proven: s.proven, ...(s.agent ? { agent: s.agent } : {}), signalsInclude: s.reasons.slice(0, 3).map((r) => r.signal) },
    evidence: ev,
  };
  const file = path.join(OUT_DIR, `${name}.json`);
  writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${file}: ${s.bucket} / ${s.type} (p=${s.probability})`);
  await client.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await client.end();
  process.exit(1);
});
