import { buildVisits, type Visit, type VisitClientRow, type VisitRequestRow, type VisitShopRow } from "@honeypot/detection";
import type { RequestIdentity } from "../sensing.js";

/**
 * Turns a merchant's stored events into the rows packages/detection's buildVisits() takes, so the
 * merchant service scores visits with exactly the same code as the honeypot.
 *
 *   page    → a request row (GET <path>): the page view, with the identity of the beacon request
 *   assess  → a request row (POST) + SHOP_ORDER_PLACED: the visitor's own request at Pay
 *   fp / behavior / probe → client rows (the page script's beacons)
 *   event   → shop rows (pay_clicked → SHOP_PAYMENT_ATTEMPT, …)
 *
 * Request rows carry no page-load id on purpose: the rendering ladder needs CSS and noscript
 * beacons that only the honeypot serves, and without them it would wrongly report "JS without CSS".
 */
export interface MerchantEventRow {
  event_id: string;
  session_id: string;
  kind: string;
  name: string | null;
  created_at: Date;
  page_view_id: string | null;
  path: string | null;
  ip: string | null;
  user_agent: string | null;
  accept_language: string | null;
  identity: RequestIdentity | null;
  data: Record<string, any>;
  lab_label?: string | null;
  lab_verified?: boolean;
}

export const SHOP_EVENT_FOR: Record<string, string> = {
  product_viewed: "SHOP_PRODUCT_VIEW",
  add_to_cart: "SHOP_ADD_TO_CART",
  checkout_started: "SHOP_CHECKOUT_START",
  pay_clicked: "SHOP_PAYMENT_ATTEMPT",
};

const ASSESS_PATH = "/checkout";

export function toVisitRows(events: MerchantEventRow[]) {
  const requests: VisitRequestRow[] = [];
  const client: VisitClientRow[] = [];
  const shop: VisitShopRow[] = [];
  const pageViews = new Set(events.filter((e) => e.kind === "page" && e.page_view_id).map((e) => `${e.session_id}|${e.page_view_id}`));
  for (const e of events) {
    if (e.kind === "page" || e.kind === "assess") {
      const id = e.identity;
      requests.push({
        request_id: e.event_id,
        created_at: e.created_at,
        actor_id: e.session_id,
        session_id: e.session_id,
        method: e.kind === "page" ? "GET" : "POST",
        path: e.kind === "page" ? normalisePath(e.path) : normalisePath(e.path ?? ASSESS_PATH),
        query_string: null,
        status_code: 200,
        user_agent_raw: e.user_agent,
        ip: e.ip,
        lab_label: e.lab_label ?? null,
        lab_verified: e.lab_verified ?? false,
        identity_verdict: id?.verdict ?? "browser",
        identity_agent: id?.agent ?? null,
        ua_library: id?.uaLibrary ?? null,
        ja4: null,
        h2_fp: null,
        wba_status: id?.wbaStatus ?? "absent",
        wba_signer: id?.wbaSigner ?? null,
        ip_tor: id?.tor ?? false,
        verdict_method: id?.method ?? null,
        verdict_reasons: id?.reasons ?? [],
        ai_app: id?.aiApp ?? null,
        browser_family: id?.browserFamily ?? null,
        flags: [],
        asn: id?.network?.asn ?? null,
        organization: id?.network?.organization ?? null,
        country: id?.network?.country ?? null,
        city: null,
        accept_language: e.accept_language,
        page_load_id: null,
      });
      if (e.kind === "assess") {
        shop.push({ session_id: e.session_id, actor_id: e.session_id, created_at: e.created_at, event_type: "SHOP_ORDER_PLACED", request_id: e.event_id, shop: { totals: { totalCents: e.data?.order?.amount ?? null } } });
      }
    } else if (e.kind === "event") {
      const type = e.name ? SHOP_EVENT_FOR[e.name] : undefined;
      if (type) shop.push({ session_id: e.session_id, actor_id: e.session_id, created_at: e.created_at, event_type: type, request_id: null, shop: null });
    } else {
      client.push({
        session_id: e.session_id,
        actor_id: e.session_id,
        kind: e.kind,
        created_at: e.created_at,
        path: e.path,
        lab_label: e.lab_label ?? null,
        lab_verified: e.lab_verified ?? false,
        page_load_id: e.page_view_id,
        // A beacon is bound when its page view was announced by this session's tag.
        bound: e.page_view_id && pageViews.has(`${e.session_id}|${e.page_view_id}`) ? true : null,
        data: e.data ?? {},
      });
    }
  }
  return { requests, client, shop };
}

/** Pages are merchant URLs, never ours: keep the path, drop the query, cap the length. */
export function normalisePath(p: string | null | undefined): string {
  if (!p) return "/";
  const path = p.split("?")[0]!.split("#")[0]!;
  return (path.startsWith("/") ? path : `/${path}`).slice(0, 512);
}

export function merchantVisits(events: MerchantEventRow[]): Visit[] {
  const rows = toVisitRows(events);
  return buildVisits(rows.requests, rows.client, rows.shop);
}
