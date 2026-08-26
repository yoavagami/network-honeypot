import type { FastifyInstance } from "fastify";
import { and, eq, gte, sql } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { classifyOrigin } from "@honeypot/detection";
import { db } from "../db.js";

const RANGE_MS: Record<string, number> = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function rangeStart(range: string | undefined, from: string | undefined): Date {
  if (from) return new Date(from);
  const ms = RANGE_MS[range ?? "24h"] ?? RANGE_MS["24h"]!;
  return new Date(Date.now() - ms);
}

export function registerAnalyticsRoutes(app: FastifyInstance) {
  app.get("/api/analytics/overview", async (request, reply) => {
    const q = request.query as { range?: string; from?: string; to?: string };
    const since = rangeStart(q.range, q.from);

    const [totals] = await db
      .select({
        totalRequests: sql<number>`count(*)::int`,
        uniqueActors: sql<number>`count(distinct actor_id)::int`,
        uniqueIps: sql<number>`count(distinct ip_hash)::int`,
        uniqueUserAgents: sql<number>`count(distinct user_agent_fingerprint)::int`,
        errorCount: sql<number>`count(*) filter (where status_code >= 400)::int`,
      })
      .from(schema.requests)
      .where(gte(schema.requests.createdAt, since));

    const methodBreakdown = await db
      .select({ method: schema.requests.method, count: sql<number>`count(*)::int` })
      .from(schema.requests)
      .where(gte(schema.requests.createdAt, since))
      .groupBy(schema.requests.method);

    const topEndpoints = await db
      .select({ path: schema.requests.path, count: sql<number>`count(*)::int` })
      .from(schema.requests)
      .where(gte(schema.requests.createdAt, since))
      .groupBy(schema.requests.path)
      .orderBy(sql`count(*) desc`)
      .limit(10);

    const eventTypeCounts = await db
      .select({ eventType: schema.events.eventType, count: sql<number>`count(*)::int` })
      .from(schema.events)
      .where(gte(schema.events.createdAt, since))
      .groupBy(schema.events.eventType)
      .orderBy(sql`count(*) desc`);

    const [canaryTotal] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.canaryEvents).where(gte(schema.canaryEvents.createdAt, since));
    const [detectionTotal] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.detections).where(gte(schema.detections.lastEventAt, since));

    reply.send({
      range: { since: since.toISOString(), until: new Date().toISOString() },
      totals: totals ?? { totalRequests: 0, uniqueActors: 0, uniqueIps: 0, uniqueUserAgents: 0, errorCount: 0 },
      methodBreakdown,
      topEndpoints,
      eventTypeCounts,
      canaryTriggerCount: canaryTotal?.count ?? 0,
      detectionCount: detectionTotal?.count ?? 0,
    });
  });

  app.get("/api/analytics/traffic", async (request, reply) => {
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);
    const bucketMinutes = (RANGE_MS[q.range ?? "24h"] ?? RANGE_MS["24h"]!) > RANGE_MS["1h"]! ? 60 : 5;

    const rows = await db
      .select({
        bucket: sql<string>`date_trunc('hour', created_at) + floor(date_part('minute', created_at) / ${bucketMinutes}) * (${bucketMinutes} || ' minutes')::interval`,
        count: sql<number>`count(*)::int`,
        uniqueActors: sql<number>`count(distinct actor_id)::int`,
      })
      .from(schema.requests)
      .where(gte(schema.requests.createdAt, since))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    reply.send({ data: rows });
  });

  app.get("/api/analytics/attacks", async (request, reply) => {
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);

    const byType = await db
      .select({ detectionType: schema.detections.detectionType, count: sql<number>`count(*)::int` })
      .from(schema.detections)
      .where(gte(schema.detections.lastEventAt, since))
      .groupBy(schema.detections.detectionType);

    const riskBuckets = await db
      .select({
        bucket: sql<string>`case when risk_score >= 80 then 'critical' when risk_score >= 60 then 'high' when risk_score >= 35 then 'medium' when risk_score >= 15 then 'low' else 'info' end`,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.requests)
      .where(gte(schema.requests.createdAt, since))
      .groupBy(sql`1`);

    reply.send({ byDetectionType: byType, riskDistribution: riskBuckets });
  });

  app.get("/api/analytics/bots", async (request, reply) => {
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);

    const byUaFingerprint = await db
      .select({ uaFingerprint: schema.requests.userAgentFingerprint, count: sql<number>`count(*)::int`, uniqueActors: sql<number>`count(distinct actor_id)::int` })
      .from(schema.requests)
      .where(and(gte(schema.requests.createdAt, since)))
      .groupBy(schema.requests.userAgentFingerprint)
      .orderBy(sql`count(*) desc`)
      .limit(20);

    reply.send({ data: byUaFingerprint });
  });

  app.get("/api/analytics/geography", async (request, reply) => {
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);

    const byCountry = await db
      .select({
        country: schema.actors.country,
        actorCount: sql<number>`count(*)::int`,
        requestCount: sql<number>`coalesce(sum(${schema.actors.totalRequests}), 0)::int`,
        avgRisk: sql<number>`round(avg(${schema.actors.riskScore}))::int`,
        maxRisk: sql<number>`max(${schema.actors.riskScore})::int`,
      })
      .from(schema.actors)
      .where(and(gte(schema.actors.lastSeenAt, since), sql`${schema.actors.country} is not null`))
      .groupBy(schema.actors.country)
      .orderBy(sql`3 desc`) // requestCount
      .limit(20);

    const byAsn = await db
      .select({
        asn: schema.actors.asn,
        organization: schema.actors.organization,
        actorCount: sql<number>`count(*)::int`,
        requestCount: sql<number>`coalesce(sum(${schema.actors.totalRequests}), 0)::int`,
        avgRisk: sql<number>`round(avg(${schema.actors.riskScore}))::int`,
        maxRisk: sql<number>`max(${schema.actors.riskScore})::int`,
      })
      .from(schema.actors)
      .where(and(gte(schema.actors.lastSeenAt, since), sql`${schema.actors.asn} is not null`))
      .groupBy(schema.actors.asn, schema.actors.organization)
      .orderBy(sql`3 desc`) // requestCount
      .limit(20);

    reply.send({ byCountry, byAsn, enrichmentActive: byCountry.length > 0 || byAsn.length > 0 });
  });

  // Drill-down targets for the Overview page's "Unique IPs" / "Unique user agents" stat cards —
  // see apps/admin-web/src/pages/OverviewPage.tsx. Raw SQL (not the query builder) because of
  // the array_agg-pick-latest-non-null trick for ip_raw, which needs to survive the fact that
  // ip_raw gets NULLed by the retention job after RAW_IP_RETENTION_DAYS while ip_hash (the
  // group-by key) persists — same reasoning as the first-contact endpoint below.
  app.get("/api/analytics/ips", async (request, reply) => {
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);

    const rows = await db.execute(sql`
      SELECT
        ip_hash AS "ipHash",
        (array_agg(ip_raw ORDER BY created_at DESC) FILTER (WHERE ip_raw IS NOT NULL))[1] AS "latestIpRaw",
        count(*)::int AS "requestCount",
        count(DISTINCT actor_id)::int AS "uniqueActors",
        min(created_at) AS "firstSeen",
        max(created_at) AS "lastSeen",
        max(risk_score)::int AS "maxRisk"
      FROM requests
      WHERE created_at >= ${since.toISOString()}
      GROUP BY ip_hash
      ORDER BY count(*) DESC
      LIMIT 100
    `);

    reply.send({ data: rows });
  });

  app.get("/api/analytics/user-agents", async (request, reply) => {
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);

    const rows = await db.execute(sql`
      SELECT
        user_agent_raw AS "userAgent",
        count(*)::int AS "requestCount",
        count(DISTINCT actor_id)::int AS "uniqueActors",
        min(created_at) AS "firstSeen",
        max(created_at) AS "lastSeen",
        max(risk_score)::int AS "maxRisk"
      FROM requests
      WHERE created_at >= ${since.toISOString()}
      GROUP BY user_agent_raw
      ORDER BY count(*) DESC
      LIMIT 100
    `);

    reply.send({ data: rows });
  });

  // Powers the Geography page's heat map — see apps/admin-web/src/components/WorldHeatmap.tsx.
  // One point per distinct actor location (lat/lng comes from GeoIP enrichment, city-level
  // precision, opt-in — see docs/PRIVACY.md), weighted by how many requests from there fell in
  // the selected range. Empty until GEOLOCATION_ENABLED is turned on and actors get enriched.
  app.get("/api/analytics/heatmap", async (request, reply) => {
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);

    // asn/organization now in the grouping (not just lat/lng/country/city) so a city with both
    // AWS-hosted and residential traffic renders as two distinctly classifiable points instead
    // of one blended one — see the infra-origin toggle in WorldHeatmap.tsx.
    const rows = await db
      .select({
        lat: schema.actors.lat,
        lng: schema.actors.lng,
        country: schema.actors.country,
        city: schema.actors.city,
        asn: schema.actors.asn,
        organization: schema.actors.organization,
        requestCount: sql<number>`count(${schema.requests.requestId})::int`,
        maxRisk: sql<number>`max(${schema.requests.riskScore})::int`,
      })
      .from(schema.actors)
      .innerJoin(schema.requests, eq(schema.requests.actorId, schema.actors.actorId))
      .where(and(gte(schema.requests.createdAt, since), sql`${schema.actors.lat} is not null`, sql`${schema.actors.lng} is not null`))
      .groupBy(schema.actors.lat, schema.actors.lng, schema.actors.country, schema.actors.city, schema.actors.asn, schema.actors.organization)
      .orderBy(sql`count(${schema.requests.requestId}) desc`)
      .limit(500);

    const data = rows.map((r) => ({ ...r, infra: classifyOrigin(r.asn, r.organization) }));
    reply.send({ data });
  });

  // Powers the Geography page's infra-origin breakdown panel — aggregate counts per classified
  // category, independent of the map (every enriched actor counts here, not just those with
  // lat/lng, since classification only needs asn/organization).
  app.get("/api/analytics/infra-origin", async (request, reply) => {
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);

    const rows = await db
      .selectDistinct({
        actorId: schema.actors.actorId,
        asn: schema.actors.asn,
        organization: schema.actors.organization,
      })
      .from(schema.actors)
      .innerJoin(schema.requests, eq(schema.requests.actorId, schema.actors.actorId))
      .where(gte(schema.requests.createdAt, since));

    const counts = new Map<string, { label: string; actorCount: number }>();
    for (const row of rows) {
      const infra = classifyOrigin(row.asn, row.organization);
      const existing = counts.get(infra.category);
      if (existing) existing.actorCount++;
      else counts.set(infra.category, { label: infra.label, actorCount: 1 });
    }

    const data = [...counts.entries()]
      .map(([category, v]) => ({ category, label: v.label, actorCount: v.actorCount }))
      .sort((a, b) => b.actorCount - a.actorCount);

    reply.send({ data });
  });

  app.get("/api/analytics/discovery-funnel", async (request, reply) => {
    // Stage membership, not a strict enforced sequence — an actor counts for "explored the API"
    // whether or not they viewed the homepage first. That matches how actual discovery behaves
    // (bots skip straight to /robots.txt or /api/* constantly) better than a funnel that would
    // silently undercount anyone who didn't follow the "expected" path. See brief §38.
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);
    const distinctActorCount = sql<number>`count(distinct actor_id)::int`;

    const [[total], [homepage], [robots], [apiExplored], [auth], [canary]] = await Promise.all([
      db.select({ n: distinctActorCount }).from(schema.requests).where(gte(schema.requests.createdAt, since)),
      db.select({ n: distinctActorCount }).from(schema.requests).where(and(gte(schema.requests.createdAt, since), eq(schema.requests.path, "/"))),
      db.select({ n: distinctActorCount }).from(schema.requests).where(and(gte(schema.requests.createdAt, since), sql`${schema.requests.path} in ('/robots.txt', '/sitemap.xml')`)),
      db.select({ n: distinctActorCount }).from(schema.requests).where(and(gte(schema.requests.createdAt, since), sql`${schema.requests.path} like '/api/%'`)),
      db
        .select({ n: distinctActorCount })
        .from(schema.events)
        .where(and(gte(schema.events.createdAt, since), sql`${schema.events.eventType} in ('LOGIN_ATTEMPT','LOGIN_FAILURE','LOGIN_SUCCESS','ADMIN_LOGIN_ATTEMPT','PASSWORD_RESET_ATTEMPT')`)),
      db.select({ n: distinctActorCount }).from(schema.canaryEvents).where(gte(schema.canaryEvents.createdAt, since)),
    ]);

    reply.send({
      stages: [
        { stage: "total", label: "All actors", actorCount: total?.n ?? 0 },
        { stage: "homepage", label: "Viewed homepage", actorCount: homepage?.n ?? 0 },
        { stage: "robots", label: "Visited robots.txt / sitemap.xml", actorCount: robots?.n ?? 0 },
        { stage: "api", label: "Explored the API", actorCount: apiExplored?.n ?? 0 },
        { stage: "auth", label: "Attempted authentication", actorCount: auth?.n ?? 0 },
        { stage: "canary", label: "Triggered a canary", actorCount: canary?.n ?? 0 },
      ],
    });
  });

  // Powers the Vulnerabilities page — see docs/VULNERABILITY.md. One row per intentionally
  // vulnerable component; today that's just the CRM search SQLi, but the shape stays the same
  // if more are ever added. Derived entirely from events already recorded by
  // apps/honeypot/src/routes/crm.ts's behavioral detection — no separate tracking needed.
  app.get("/api/analytics/vulnerabilities", async (request, reply) => {
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);

    const [sqli] = await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE event_type = 'SQLI_PROBE')::int AS attempts,
        count(*) FILTER (WHERE event_type = 'SQLI_CONFIRMED')::int AS confirmed,
        count(*) FILTER (WHERE event_type = 'DATA_EXTRACTION')::int AS "dataExtractionEvents",
        count(DISTINCT actor_id) FILTER (WHERE event_type IN ('SQLI_PROBE', 'SQLI_CONFIRMED'))::int AS actors,
        min(created_at) FILTER (WHERE event_type = 'SQLI_PROBE') AS "firstAttemptAt",
        min(created_at) FILTER (WHERE event_type = 'SQLI_CONFIRMED') AS "firstConfirmedAt"
      FROM events
      WHERE created_at >= ${since.toISOString()}
        AND event_type IN ('SQLI_PROBE', 'SQLI_CONFIRMED', 'DATA_EXTRACTION')
    `);

    // Canary events specifically tied to secrets this vulnerability planted (crm_api_integrations
    // rows) — distinct from the site-wide canary count elsewhere, which covers every canary type.
    const [canary] = await db.execute(sql`
      SELECT count(*)::int AS n
      FROM canary_events ce
      JOIN canary_objects co ON co.canary_id = ce.canary_id
      WHERE co.planted_location LIKE 'crm_api_integrations%'
        AND ce.created_at >= ${since.toISOString()}
    `);

    // Backdoor/webshell bait (apps/honeypot/src/routes/backdoor.ts) — attempts/confirmed/
    // dataExtractionEvents are repurposed here as hit/recognized-command/iteration counts. No
    // canary linkage for this one (the bait doesn't plant anything reusable elsewhere), so that
    // column is always 0 for this row.
    const [backdoor] = await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE event_type = 'BACKDOOR_PATH_HIT')::int AS attempts,
        count(*) FILTER (WHERE event_type = 'BACKDOOR_COMMAND_RECOGNIZED')::int AS confirmed,
        count(*) FILTER (WHERE event_type = 'BACKDOOR_COMMAND_ITERATION')::int AS iterations,
        count(DISTINCT actor_id) FILTER (WHERE event_type IN ('BACKDOOR_PATH_HIT', 'BACKDOOR_ENGAGED', 'BACKDOOR_COMMAND_RECOGNIZED', 'BACKDOOR_COMMAND_ITERATION'))::int AS actors,
        min(created_at) FILTER (WHERE event_type = 'BACKDOOR_PATH_HIT') AS "firstAttemptAt",
        min(created_at) FILTER (WHERE event_type = 'BACKDOOR_COMMAND_RECOGNIZED') AS "firstConfirmedAt"
      FROM events
      WHERE created_at >= ${since.toISOString()}
        AND event_type IN ('BACKDOOR_PATH_HIT', 'BACKDOOR_ENGAGED', 'BACKDOOR_COMMAND_RECOGNIZED', 'BACKDOOR_COMMAND_ITERATION')
    `);

    reply.send({
      data: [
        {
          vulnerability: "SQL Injection",
          category: "Injection",
          endpoint: "GET /api/v1/customers",
          firstAttemptAt: sqli?.firstAttemptAt ?? null,
          firstConfirmedAt: sqli?.firstConfirmedAt ?? null,
          actors: sqli?.actors ?? 0,
          attempts: sqli?.attempts ?? 0,
          confirmed: sqli?.confirmed ?? 0,
          dataExtractionEvents: sqli?.dataExtractionEvents ?? 0,
          canaryEvents: canary?.n ?? 0,
        },
        {
          vulnerability: "Webshell/Backdoor Bait",
          category: "Fake RCE",
          endpoint: "Various — see docs/VULNERABILITY.md",
          firstAttemptAt: backdoor?.firstAttemptAt ?? null,
          firstConfirmedAt: backdoor?.firstConfirmedAt ?? null,
          actors: backdoor?.actors ?? 0,
          attempts: backdoor?.attempts ?? 0,
          confirmed: backdoor?.confirmed ?? 0,
          dataExtractionEvents: backdoor?.iterations ?? 0,
          canaryEvents: 0,
        },
      ],
    });
  });

  app.get("/api/analytics/first-contact", async (request, reply) => {
    // "How quickly after deployment did scanners discover the site?" — see docs/ROADMAP.md
    // Phase 2 / brief §37. Deliberately not bounded by the range selector elsewhere on this
    // page: first-contact timing is about each actor's own journey, not a fixed calendar window.
    // Scans all of events/detections/canary_events, which is fine at Phase 1/2 volume; if this
    // gets slow at scale, the fix is maintaining these as columns on `actors` updated
    // incrementally (same pattern as risk_score/unique_paths), not re-deriving on every request.
    const rows = await db.execute(sql`
      WITH event_first AS (
        SELECT
          actor_id,
          min(created_at) FILTER (WHERE risk_score >= 15) AS first_suspicious_at,
          min(created_at) FILTER (
            WHERE event_type IN ('LOGIN_ATTEMPT','LOGIN_FAILURE','LOGIN_SUCCESS','ADMIN_LOGIN_ATTEMPT','PASSWORD_RESET_ATTEMPT')
          ) AS first_auth_attempt_at
        FROM events
        GROUP BY actor_id
      ),
      detection_first AS (
        SELECT
          actor_id,
          min(first_event_at) FILTER (WHERE detection_type = 'enumeration') AS first_enumeration_at,
          min(first_event_at) FILTER (WHERE detection_type = 'api_probing') AS first_api_probe_at
        FROM detections
        GROUP BY actor_id
      ),
      canary_first AS (
        SELECT actor_id, min(created_at) AS first_canary_trigger_at
        FROM canary_events
        GROUP BY actor_id
      )
      SELECT
        a.actor_id AS "actorId",
        a.first_seen_at AS "firstSeenAt",
        a.last_seen_at AS "lastSeenAt",
        ef.first_suspicious_at AS "firstSuspiciousAt",
        ef.first_auth_attempt_at AS "firstAuthAttemptAt",
        df.first_enumeration_at AS "firstEnumerationAt",
        df.first_api_probe_at AS "firstApiProbeAt",
        cf.first_canary_trigger_at AS "firstCanaryTriggerAt",
        extract(epoch FROM (ef.first_suspicious_at - a.first_seen_at))::int AS "secondsToFirstSuspicious",
        extract(epoch FROM (cf.first_canary_trigger_at - a.first_seen_at))::int AS "secondsToFirstCanary"
      FROM actors a
      LEFT JOIN event_first ef ON ef.actor_id = a.actor_id
      LEFT JOIN detection_first df ON df.actor_id = a.actor_id
      LEFT JOIN canary_first cf ON cf.actor_id = a.actor_id
      ORDER BY a.first_seen_at DESC
      LIMIT 100
    `);
    reply.send({ data: rows });
  });
}
