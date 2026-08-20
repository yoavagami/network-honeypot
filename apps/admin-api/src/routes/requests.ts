import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lte, lt, ilike, notIlike, sql } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "../db.js";
import { audit } from "../audit.js";

/**
 * Raw per-request log ("every touch") — distinct from /api/events, which is keyed on the
 * events table (event_type-classified, potentially several per request) and from the live-only
 * SSE stream. This is a plain paginated table over `requests` for scanning/searching everything
 * that hit the honeypot, actor-derived geography joined in for convenience. See docs/API.md.
 */

interface RequestsQuery {
  from?: string;
  to?: string;
  actor_id?: string;
  method?: string;
  path?: string;
  ip?: string;
  /** Exact match on the long-term correlation key — used to drill in from the Overview page's
   * "Unique IPs" breakdown, where older rows may only have this left (ip_raw redacted after
   * RAW_IP_RETENTION_DAYS). `ip` above is a raw-IP substring match instead, for the Requests
   * page's own free-text filter. */
  ip_hash?: string;
  status_code?: string;
  /** Drill-in target for the Overview page's "Errors (4xx/5xx)" card — status_code above is
   * exact-match, this is a floor. */
  min_status?: string;
  user_agent?: string;
  /** Excludes rows whose user-agent contains this — the noisy-platform-pinger case (e.g.
   * Render's own health-check UA drowning out real traffic), not a general boolean query
   * language. Combine with user_agent if you need both an include and an exclude at once. */
  exclude_user_agent?: string;
  cursor?: string;
  limit?: string;
}

export function registerRequestRoutes(app: FastifyInstance) {
  app.get("/api/requests", async (request, reply) => {
    const q = request.query as RequestsQuery;
    const limit = Math.min(200, Number(q.limit ?? 50));
    const conditions = [];
    if (q.from) conditions.push(gte(schema.requests.createdAt, new Date(q.from)));
    if (q.to) conditions.push(lte(schema.requests.createdAt, new Date(q.to)));
    if (q.actor_id) conditions.push(eq(schema.requests.actorId, q.actor_id));
    if (q.method) conditions.push(eq(schema.requests.method, q.method));
    if (q.path) conditions.push(ilike(schema.requests.path, `%${q.path}%`));
    // ip_raw is a Postgres `inet` column — ILIKE needs a text operand, so cast via host().
    // Confirmed live: querying it as ilike(ipRaw, ...) directly errors with "operator does not
    // exist: inet ~~* unknown".
    if (q.ip) conditions.push(ilike(sql`host(${schema.requests.ipRaw})`, `%${q.ip}%`));
    if (q.ip_hash) conditions.push(eq(schema.requests.ipHash, q.ip_hash));
    if (q.status_code) conditions.push(eq(schema.requests.statusCode, Number(q.status_code)));
    if (q.min_status) conditions.push(gte(schema.requests.statusCode, Number(q.min_status)));
    if (q.user_agent) conditions.push(ilike(schema.requests.userAgentRaw, `%${q.user_agent}%`));
    if (q.exclude_user_agent) conditions.push(notIlike(schema.requests.userAgentRaw, `%${q.exclude_user_agent}%`));
    if (q.cursor) conditions.push(lt(schema.requests.createdAt, new Date(q.cursor)));

    const rows = await db
      .select({
        requestId: schema.requests.requestId,
        createdAt: schema.requests.createdAt,
        actorId: schema.requests.actorId,
        ipHash: schema.requests.ipHash,
        // Raw IP is a deliberate exception to how the rest of the dashboard only ever shows
        // ip_hash — see docs/PRIVACY.md. It's only populated for RAW_IP_RETENTION_DAYS (default
        // 7 days) before the retention job NULLs it; rows older than that show null here too,
        // same as the underlying column.
        ipRaw: schema.requests.ipRaw,
        method: schema.requests.method,
        path: schema.requests.path,
        queryString: schema.requests.queryString,
        statusCode: schema.requests.statusCode,
        userAgentRaw: schema.requests.userAgentRaw,
        riskScore: schema.requests.riskScore,
        endpoint: schema.requests.endpoint,
        applicationComponent: schema.requests.applicationComponent,
        country: schema.actors.country,
        region: schema.actors.region,
        city: schema.actors.city,
      })
      .from(schema.requests)
      .leftJoin(schema.actors, eq(schema.requests.actorId, schema.actors.actorId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.requests.createdAt))
      .limit(limit);

    await audit(request.adminSession!.adminUserId, "list_requests", null, null, { count: rows.length });
    reply.send({ data: rows, nextCursor: rows.length === limit ? rows[rows.length - 1]?.createdAt : null });
  });
}
