import type { FastifyInstance } from "fastify";
import { signLabToken } from "@honeypot/detection";
import { client } from "../db.js";
import { config } from "../config.js";
import { audit } from "../audit.js";
import { parseLabRunInput } from "../agentsQuery.js";

/**
 * Lab runs — controlled visits we start ourselves, the ground truth the agent score is measured
 * against. A run is a signed link (packages/detection/src/labToken.ts): opening it tags that
 * browser with the label until the link expires. Bare ?lab= labels are "claimed" only, because any
 * visitor can type one (SDK_V2_IMPLEMENTATION_PLAN.md F1).
 */
export function registerLabRoutes(app: FastifyInstance) {
  app.post("/api/lab/runs", async (request, reply) => {
    if (!config.labLinkSecret) return reply.status(503).send({ error: { code: "lab_disabled", message: "LAB_LINK_SECRET is not configured" } });
    const parsed = parseLabRunInput((request.body ?? {}) as Record<string, unknown>);
    if (!parsed.ok) return reply.status(400).send({ error: { code: "invalid", message: parsed.error } });
    const run = parsed.value;
    const expiresAt = new Date(Date.now() + run.ttlDays * 86400_000);
    const [existing] = await client`SELECT 1 FROM lab_runs WHERE label = ${run.label}`;
    if (existing) return reply.status(409).send({ error: { code: "exists", message: `label ${run.label} was already used — bump the run number` } });
    await client`
      INSERT INTO lab_runs (label, kind, agent, scenario, notes, created_by, created_at, expires_at)
      VALUES (${run.label}, ${run.kind}, ${run.agent}, ${run.scenario}, ${run.notes}, ${request.adminSession!.adminUserId}, now(), ${expiresAt.toISOString()}::timestamptz)`;
    const token = signLabToken(run.label, Math.floor(expiresAt.getTime() / 1000), config.labLinkSecret);
    const query = `?lab=${encodeURIComponent(token)}`;
    await audit(request.adminSession!.adminUserId, "create_lab_run", run.label, null, { kind: run.kind, agent: run.agent, expiresAt });
    void syncLabRunKinds([{ label: run.label, kind: run.kind }]);
    return reply.status(201).send({ label: run.label, kind: run.kind, expiresAt, query, url: config.publicSiteUrl ? `${config.publicSiteUrl}/${query}` : null });
  });

  app.get("/api/lab/runs", async (request) => {
    const rows = await client<Array<{
      label: string; kind: string; agent: string | null; scenario: string | null; notes: string | null; created_at: Date; expires_at: Date;
      created_by: string | null; visits: number; last_seen: Date | null; buckets: Record<string, number> | null; proven: number;
      detected_agents: string[] | null;
    }>>`
      SELECT l.label, l.kind, l.agent, l.scenario, l.notes, l.created_at, l.expires_at, u.username AS created_by,
             count(v.visit_id)::int AS visits, max(v.last_at) AS last_seen,
             (SELECT jsonb_object_agg(bucket, n) FROM (SELECT bucket, count(*)::int AS n FROM visit_scores
                WHERE lab_label = l.label AND lab_verified GROUP BY bucket) b) AS buckets,
             count(v.visit_id) FILTER (WHERE v.proven)::int AS proven,
             array_remove(array_agg(DISTINCT v.agent), NULL) AS detected_agents
      FROM lab_runs l
      LEFT JOIN admin_users u ON u.admin_user_id = l.created_by
      LEFT JOIN visit_scores v ON v.lab_label = l.label AND v.lab_verified
      GROUP BY l.label, u.username
      ORDER BY l.created_at DESC
      LIMIT 500`;
    await audit(request.adminSession!.adminUserId, "list_lab_runs", null, null, { count: rows.length });
    const merchantRuns = await merchantLabRuns(rows.map((r) => r.label));
    return {
      enabled: Boolean(config.labLinkSecret),
      data: rows.map((r) => {
        const m = merchantRuns.get(r.label);
        const buckets: Record<string, number> = { ...(r.buckets ?? {}) };
        for (const [b, n] of Object.entries(m?.buckets ?? {})) buckets[b] = (buckets[b] ?? 0) + Number(n);
        const lastSeen = [r.last_seen, m?.last_seen].filter(Boolean).map((d) => new Date(d as string | Date)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        return {
          label: r.label, kind: r.kind, agent: r.agent, scenario: r.scenario, notes: r.notes, createdAt: r.created_at, expiresAt: r.expires_at,
          createdBy: r.created_by, visits: r.visits + (m?.visits ?? 0), lastSeen, buckets, proven: r.proven + (m?.proven ?? 0),
          detectedAgents: [...new Set([...(r.detected_agents ?? []), ...(m?.detected_agents ?? [])])],
          // Where the run's visits were seen: the honeypot itself and/or merchant sites.
          sites: [...(r.visits > 0 ? ["uhoney.shop"] : []), ...(m?.sites ?? [])],
        };
      }),
    };
  });
}

/**
 * Tells merchant-api each lab run's kind (agent or human), so orders from lab runs on merchant
 * sites get their known outcome there. Fails soft: the next sync catches up.
 */
export async function syncLabRunKinds(runs?: Array<{ label: string; kind: string }>): Promise<boolean> {
  if (!config.merchantInternalUrl || !config.merchantInternalToken) return false;
  try {
    const list = runs ?? (await client<Array<{ label: string; kind: string }>>`SELECT label, kind FROM lab_runs ORDER BY created_at DESC LIMIT 2000`);
    if (!list.length) return true;
    const res = await fetch(`${config.merchantInternalUrl}/internal/lab-runs`, {
      method: "POST",
      headers: { "x-internal-token": config.merchantInternalToken, "content-type": "application/json" },
      body: JSON.stringify({ runs: list.map((r) => ({ label: r.label, kind: r.kind })) }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Lab runs can also happen on merchant sites (the merchant tag reads ?lab=): their visits live in
 * the merchant database, so ask merchant-api. Fails soft: without it the scorecard shows honeypot
 * visits only.
 */
async function merchantLabRuns(labels: string[]): Promise<Map<string, { visits: number; last_seen: string | null; buckets: Record<string, number> | null; proven: number; detected_agents: string[]; sites: string[] }>> {
  const out = new Map();
  if (!labels.length || !config.merchantInternalUrl || !config.merchantInternalToken) return out;
  try {
    const res = await fetch(`${config.merchantInternalUrl}/internal/lab-visits?labels=${encodeURIComponent(labels.slice(0, 200).join(","))}`, {
      headers: { "x-internal-token": config.merchantInternalToken }, signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return out;
    const body = (await res.json()) as { runs: Array<{ label: string }> };
    for (const r of body.runs) out.set(r.label, r);
  } catch { /* merchant service unavailable */ }
  return out;
}
