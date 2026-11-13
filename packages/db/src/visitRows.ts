import type postgres from "postgres";
import type { VisitClientRow, VisitRequestRow, VisitShopRow } from "@honeypot/detection";

/**
 * Loads the rows packages/detection's buildVisits() groups into visits: requests that have a
 * request_signals row (captured since agent sensing went live), their actors' page-script beacons
 * and SHOP_* events. Shared by the honeypot's scoring worker and the admin API's visit detail
 * page, so both see the same visits. Runs with either service's role (both have SELECT).
 *
 * Requests are taken newest-first up to `maxRequests` and returned oldest-first, so a cap never
 * hides the most recent activity.
 */

export interface VisitRowsQuery {
  since: Date;
  until?: Date;
  sessionId?: string;
  actorIds?: string[];
  maxRequests?: number;
}

export interface VisitRows {
  requests: VisitRequestRow[];
  client: VisitClientRow[];
  shop: VisitShopRow[];
  truncated: boolean;
}

/** Beacons can arrive a little after the visit's last request (pagehide flushes). */
const TRAILING_BEACON_MS = 5 * 60_000;

export async function loadVisitRows(sql: postgres.Sql, q: VisitRowsQuery): Promise<VisitRows> {
  const max = q.maxRequests ?? 25_000;
  const since = q.since.toISOString();
  const until = (q.until ?? new Date(Date.now() + 60_000)).toISOString();
  const scope = q.sessionId
    ? sql`AND r.session_id = ${q.sessionId}`
    : q.actorIds
      ? sql`AND r.actor_id = ANY(${q.actorIds}::uuid[])`
      : sql``;
  const requests = await sql<VisitRequestRow[]>`
    SELECT * FROM (
      SELECT r.request_id, r.created_at, r.actor_id, r.session_id, r.method, r.path, r.query_string, r.status_code, r.user_agent_raw,
             host(r.ip_raw) AS ip, s.lab_label, s.lab_verified, s.identity_verdict, s.identity_agent, s.ua_library, s.ja4, s.h2_fp,
             s.wba_status, s.wba_signer, s.ip_tor, s.data #>> '{identity,method}' AS verdict_method,
             ARRAY(SELECT jsonb_array_elements_text(coalesce(s.data #> '{identity,reasons}', '[]'))) AS verdict_reasons,
             s.data #>> '{ua,aiApp}' AS ai_app, s.data #>> '{ua,browser,family}' AS browser_family,
             ARRAY(SELECT jsonb_array_elements_text(coalesce(s.data -> 'consistencyFlags', '[]'))) AS flags,
             s.data #>> '{headers,values,accept-language}' AS accept_language,
             coalesce(s.page_load_id, s.data ->> 'pageLoadId') AS page_load_id,
             a.asn, a.organization, a.country, a.city
      FROM requests r
      JOIN request_signals s USING (request_id)
      LEFT JOIN actors a ON a.actor_id = r.actor_id
      WHERE r.created_at >= ${since}::timestamptz AND r.created_at < ${until}::timestamptz ${scope}
      ORDER BY r.created_at DESC
      LIMIT ${max}
    ) newest ORDER BY created_at ASC`;
  // This client hands timestamps back as strings (see packages/db client config).
  for (const r of requests) r.created_at = new Date(r.created_at);
  const truncated = requests.length >= max;
  const actorIds = [...new Set(requests.map((r) => r.actor_id))];
  if (!actorIds.length) return { requests, client: [], shop: [], truncated };

  const clientUntil = new Date(new Date(until).getTime() + TRAILING_BEACON_MS).toISOString();
  const client = await sql<VisitClientRow[]>`
    SELECT session_id, actor_id, kind, created_at, path, lab_label, lab_verified, page_load_id, bound, data
    FROM client_signals
    WHERE created_at >= ${since}::timestamptz AND created_at < ${clientUntil}::timestamptz AND actor_id = ANY(${actorIds}::uuid[])
    ORDER BY created_at`;
  const shop = await sql<VisitShopRow[]>`
    SELECT session_id, actor_id, created_at, event_type, request_id, metadata -> 'shop' AS shop
    FROM events
    WHERE created_at >= ${since}::timestamptz AND created_at < ${until}::timestamptz AND event_type LIKE 'SHOP\\_%' AND actor_id = ANY(${actorIds}::uuid[])
    ORDER BY created_at`;
  for (const c of client) c.created_at = new Date(c.created_at);
  for (const e of shop) e.created_at = new Date(e.created_at);
  return { requests, client, shop, truncated };
}
