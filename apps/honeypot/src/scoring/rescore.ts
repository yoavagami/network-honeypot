/**
 * `pnpm rescore [--days N]` — rescores every visit with activity in the last N days (default 7)
 * with the current SCORER_VERSION and stores the result in visit_scores. Run after changing a
 * weight or signal, or once after migration 0012 to backfill. Uses the honeypot's own DB role.
 * Each actor's whole window is loaded at once, so visits are never split at a window edge.
 */
import { client } from "../db.js";
import { SCORER_VERSION } from "@honeypot/detection";
import { scoreActors } from "./visitScorer.js";

async function main() {
  const i = process.argv.indexOf("--days");
  const days = i > 0 ? Number(process.argv[i + 1]) : 7;
  if (!Number.isFinite(days) || days <= 0 || days > 90) throw new Error("--days must be between 1 and 90");
  const since = new Date(Date.now() - days * 86400_000);
  const actors = await client<{ actor_id: string }[]>`
    SELECT DISTINCT actor_id FROM request_signals WHERE created_at >= ${since.toISOString()}::timestamptz`;
  const res = await scoreActors(client, actors.map((a) => a.actor_id), { since });
  console.log(`rescored ${res.visits} visits of ${res.actors} actors with scorer ${SCORER_VERSION}${res.truncatedActors ? ` (${res.truncatedActors} actors hit the request cap)` : ""}`);
  await client.end();
}

main().catch(async (err) => {
  console.error(err);
  await client.end();
  process.exit(1);
});
