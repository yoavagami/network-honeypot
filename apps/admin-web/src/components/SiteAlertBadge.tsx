import { useEffect, useState } from "react";
import { adminMerchants } from "../merchantApi.js";

/**
 * "New since you last looked" for site alerts (agent file read, developer guide opened, access
 * request). Last-seen is per browser; opening Merchants → Site alerts resets it.
 */
const KEY = "uh.siteAlertsSeenAt";
const EVENT = "uh:site-alerts-seen";

export function siteAlertsSeenAt(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function markSiteAlertsSeen() {
  try { localStorage.setItem(KEY, new Date().toISOString()); } catch { /* private mode: badge just stays */ }
  window.dispatchEvent(new Event(EVENT));
}

export function SiteAlertBadge() {
  const [n, setN] = useState(0);
  useEffect(() => {
    let stop = false;
    const load = () => document.visibilityState === "hidden" ? undefined : adminMerchants.siteAlertCount(siteAlertsSeenAt() ?? undefined).then((r) => { if (!stop) setN(r.new_count); }).catch(() => { if (!stop) setN(0); });
    void load();
    const t = setInterval(load, 60_000);
    window.addEventListener(EVENT, load);
    document.addEventListener("visibilitychange", load);
    return () => { stop = true; clearInterval(t); window.removeEventListener(EVENT, load); document.removeEventListener("visibilitychange", load); };
  }, []);
  if (!n) return null;
  return <span className="badge critical" style={{ marginLeft: ".4rem" }} title={`${n} new site alert${n > 1 ? "s" : ""}`}>{n}</span>;
}
