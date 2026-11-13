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
    return reply.status(201).send({ label: run.label, kind: run.kind, expiresAt, query, url: config.publicSiteUrl ? `${config.publicSiteUrl}/${query}` : null });
  });

  app.get("/api/lab/runs", async (request) => {
    const rows = await client<Array<{
      label: string; kind: string; agent: string | null; scenario: string | null; notes: string | null; created_at: Date; expires_at: Date;
      created_by: string | null; visits: number; last_seen: Date | null; buckets: Record<string, number> | null; proven: number;
    }>>`
      SELECT l.label, l.kind, l.agent, l.scenario, l.notes, l.created_at, l.expires_at, u.username AS created_by,
             count(v.visit_id)::int AS visits, max(v.last_at) AS last_seen,
             (SELECT jsonb_object_agg(bucket, n) FROM (SELECT bucket, count(*)::int AS n FROM visit_scores
                WHERE lab_label = l.label AND lab_verified GROUP BY bucket) b) AS buckets,
             count(v.visit_id) FILTER (WHERE v.proven)::int AS proven
      FROM lab_runs l
      LEFT JOIN admin_users u ON u.admin_user_id = l.created_by
      LEFT JOIN visit_scores v ON v.lab_label = l.label AND v.lab_verified
      GROUP BY l.label, u.username
      ORDER BY l.created_at DESC
      LIMIT 500`;
    await audit(request.adminSession!.adminUserId, "list_lab_runs", null, null, { count: rows.length });
    return {
      enabled: Boolean(config.labLinkSecret),
      data: rows.map((r) => ({
        label: r.label, kind: r.kind, agent: r.agent, scenario: r.scenario, notes: r.notes, createdAt: r.created_at, expiresAt: r.expires_at,
        createdBy: r.created_by, visits: r.visits, lastSeen: r.last_seen, buckets: r.buckets ?? {}, proven: r.proven,
      })),
    };
  });
}
