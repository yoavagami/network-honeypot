import type { FastifyInstance } from "fastify";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveClientIp } from "@honeypot/detection";
import { config } from "../config.js";
import { audit } from "../audit.js";

/**
 * Superadmin-only view of who touched the public dashboard itself — read from the JSON access log
 * admin-web's Nginx writes (infrastructure/nginx/admin-web-public-tls.conf), mounted read-only
 * here by infrastructure/vps/docker-compose.public-admin.yml. Same data as
 * infrastructure/aws/admin-access.sh, summarized server-side.
 *
 * Access control: middleware.ts already 404s non-superadmins before this handler runs; the role
 * check here is a second, independent gate so a future middleware change can't silently open it.
 */

const LOG_DIR = process.env.ADMIN_ACCESS_LOG_DIR ?? "/var/log/admin-access";
const RANGES: Record<string, number | null> = { "24h": 24 * 3600_000, "7d": 7 * 86400_000, "30d": 30 * 86400_000, all: null };
const RECENT_LIMIT = 200;

interface AccessLine {
  time: string;
  ip: string;
  method: string;
  uri: string;
  status: number;
  bytes: number;
  request_time: number;
  user_agent: string;
  referer: string;
  host: string;
  tls: string;
}

async function readAccessLog(): Promise<{ available: boolean; lines: AccessLine[] }> {
  let files: string[];
  try {
    files = await readdir(LOG_DIR);
  } catch {
    return { available: false, lines: [] };
  }
  // Oldest rotated file first (access.log.8 … access.log.1), then the live file.
  const rotated = files
    .filter((f) => /^access\.log\.\d+$/.test(f))
    .sort((a, b) => Number(b.split(".").pop()) - Number(a.split(".").pop()));
  const ordered = [...rotated, ...(files.includes("access.log") ? ["access.log"] : [])];

  const lines: AccessLine[] = [];
  for (const file of ordered) {
    const text = await readFile(join(LOG_DIR, file), "utf8").catch(() => "");
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      try {
        lines.push(JSON.parse(raw) as AccessLine);
      } catch {
        // A half-written last line during rotation — skip it.
      }
    }
  }
  return { available: true, lines };
}

function loginResult(status: number): "success" | "wrong_password" | "rate_limited" | "other" {
  if (status === 200) return "success";
  if (status === 401) return "wrong_password";
  if (status === 429) return "rate_limited";
  return "other";
}

export function registerAccessLogRoutes(app: FastifyInstance) {
  app.get("/api/access-log", async (request, reply) => {
    if (request.adminSession?.role !== "superadmin") {
      reply.callNotFound();
      return;
    }

    const q = request.query as { range?: string };
    const range = q.range && q.range in RANGES ? q.range : "7d";
    const windowMs = RANGES[range] ?? null;
    const sinceMs = windowMs === null ? 0 : Date.now() - windowMs;

    const { available, lines } = await readAccessLog();
    const inWindow = lines.filter((l) => Date.parse(l.time) >= sinceMs);

    const byIp = new Map<string, { ip: string; hits: number; loginsOk: number; loginsFailed: number; firstSeen: string; lastSeen: string; userAgent: string }>();
    for (const l of inWindow) {
      const v = byIp.get(l.ip) ?? { ip: l.ip, hits: 0, loginsOk: 0, loginsFailed: 0, firstSeen: l.time, lastSeen: l.time, userAgent: l.user_agent };
      v.hits += 1;
      if (l.uri === "/api/auth/login" && l.method === "POST") {
        if (l.status === 200) v.loginsOk += 1;
        else if (l.status === 401 || l.status === 429) v.loginsFailed += 1;
      }
      if (l.time < v.firstSeen) v.firstSeen = l.time;
      if (l.time >= v.lastSeen) {
        v.lastSeen = l.time;
        v.userAgent = l.user_agent;
      }
      byIp.set(l.ip, v);
    }

    const logins = inWindow
      .filter((l) => l.uri === "/api/auth/login" && l.method === "POST")
      .map((l) => ({ time: l.time, ip: l.ip, result: loginResult(l.status), userAgent: l.user_agent }))
      .reverse();

    const recent = inWindow
      .slice(-RECENT_LIMIT)
      .reverse()
      .map((l) => ({ time: l.time, ip: l.ip, method: l.method, uri: l.uri, status: l.status, userAgent: l.user_agent }));

    await audit(request.adminSession.adminUserId, "view_access_log", null, null, { range, lines: inWindow.length });

    reply.send({
      available,
      range,
      viewerIp: resolveClientIp(request.ip, request.headers["cf-connecting-ip"], config.trustCfConnectingIp),
      totals: { requests: inWindow.length, uniqueIps: byIp.size, loginsOk: logins.filter((l) => l.result === "success").length, loginsFailed: logins.filter((l) => l.result !== "success" && l.result !== "other").length },
      visitors: [...byIp.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1)),
      logins,
      recent,
    });
  });
}
