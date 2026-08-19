import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { schema } from "@honeypot/db";
import { hashIp, userAgentFingerprint, evaluateInline, computeEventRiskScore, type RiskFlag } from "@honeypot/detection";
import type { EventType } from "@honeypot/types";
import { db } from "../db.js";
import { config } from "../config.js";
import { resolveActor, resolveSession } from "./correlation.js";
import { getActiveCanaryValues, findCanaryByValue } from "./canaries.js";
import { fireCanaryAlert } from "./alerts.js";
import { recentBuffer } from "./recentBuffer.js";
import { metrics } from "./metrics.js";
import { enrichActorIfNeeded } from "./enrichment.js";
import type { IngestionQueue } from "./queue.js";
import "../context.js";

const VISITOR_COOKIE = "hp_visitor";
const SESSION_COOKIE = "hp_session";

export function registerIngestion(app: FastifyInstance, queue: IngestionQueue) {
  // Actor/session resolution happens on the request path (not deferred to onResponse) because
  // route handlers need to know "who is this" to render deception state (e.g. an authenticated
  // profile page) and because the session cookie must be set before headers go out. This is a
  // small, necessary latency cost distinct from event *logging*, which stays fully async — see
  // docs/ARCHITECTURE.md §4.
  app.addHook("onRequest", async (request, reply) => {
    // /internal/* is infrastructure-to-infrastructure traffic (admin-api scraping ingestion
    // health), not visitor activity — excluded from actor/event capture so it doesn't pollute
    // actor telemetry with the platform's own health checks. See docs/ARCHITECTURE.md §11.
    if (request.url.startsWith("/internal/")) {
      request.hp = {
        endpoint: "internal",
        applicationComponent: "internal",
        isAdminArea: false,
        routeMatched: true,
        methodAllowed: true,
        paramValidationFailed: false,
        canaryHaystacks: [],
        extraEventTypes: [],
        startedAtMs: Date.now(),
        visitorId: "",
        actorId: "",
        sessionId: "",
        ipHash: "",
        uaFingerprint: "",
        skipIngestion: true,
      };
      return;
    }

    request.hp = {
      endpoint: "unknown",
      applicationComponent: "unknown",
      isAdminArea: false,
      routeMatched: true,
      methodAllowed: true,
      paramValidationFailed: false,
      canaryHaystacks: [],
      extraEventTypes: [],
      startedAtMs: Date.now(),
      visitorId: "",
      actorId: "",
      sessionId: "",
      ipHash: "",
      uaFingerprint: "",
    };

    let visitorId = request.cookies[VISITOR_COOKIE];
    if (!visitorId) {
      visitorId = randomUUID();
      reply.setCookie(VISITOR_COOKIE, visitorId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
    }
    request.hp.visitorId = visitorId;

    const ip = request.ip;
    const ipHash = hashIp(ip, config.ipHashSecret);
    const userAgentRaw = request.headers["user-agent"] ?? null;
    const uaFingerprint = userAgentFingerprint(userAgentRaw);
    request.hp.ipHash = ipHash;
    request.hp.uaFingerprint = uaFingerprint;

    const { actorId } = await resolveActor({ visitorId, ipHash, uaFingerprint });
    request.hp.actorId = actorId;

    // Deliberately not awaited — enrichment is an external HTTP call and must never sit on the
    // request path (see docs/ARCHITECTURE.md §5 / packages/detection/src/enrichment.ts). A slow
    // or failing provider only delays when the actor's country/ASN appear in the dashboard,
    // never the visitor's response.
    void enrichActorIfNeeded(ip, actorId);

    const sessionCookie = request.cookies[SESSION_COOKIE];
    const sessionId = await resolveSession(actorId, sessionCookie, visitorId, ipHash, userAgentRaw, uaFingerprint);
    request.hp.sessionId = sessionId;
    if (!sessionCookie) {
      reply.setCookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 12 });
    }

    request.hp.canaryHaystacks.push(request.url, request.headers.authorization ?? null, ...Object.values(request.query as Record<string, string>));
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.hp.skipIngestion) return;
    void finalizeRequest(request, reply, queue).catch((err) => {
      metrics.eventsFailedTotal += 1;
      app.log.error({ msg: "ingestion finalize failed", err: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function finalizeRequest(request: FastifyRequest, reply: FastifyReply, queue: IngestionQueue) {
  metrics.requestsTotal += 1;
  const durationMs = Date.now() - request.hp.startedAtMs;
  const { actorId, sessionId, ipHash, uaFingerprint } = request.hp;
  const userAgentRaw = request.headers["user-agent"] ?? null;

  const inline = evaluateInline({
    path: request.url.split("?")[0]!,
    method: request.method,
    routeMatched: request.hp.routeMatched,
    methodAllowed: request.hp.methodAllowed,
    paramValidationFailed: request.hp.paramValidationFailed,
    userAgent: userAgentRaw,
    isAdminArea: request.hp.isAdminArea,
    hasRefererFromSite: Boolean(request.headers.referer?.includes(request.headers.host ?? "")),
    candidateCanaryHaystacks: request.hp.canaryHaystacks,
    activeCanaryValues: getActiveCanaryValues(),
  });

  const riskFlags: RiskFlag[] = [...inline.riskFlags];
  const riskScore = computeEventRiskScore(riskFlags);

  const requestId = randomUUID();
  const path = request.url.split("?")[0]!;

  queue.enqueue({
    kind: "request",
    priority: inline.canaryMatches.length > 0 ? "high" : "low",
    row: {
      requestId,
      createdAt: new Date(),
      actorId,
      sessionId,
      ipHash,
      ipRaw: request.ip,
      sourcePort: request.socket.remotePort ?? null,
      method: request.method,
      scheme: request.protocol,
      host: request.headers.host ?? "",
      path,
      queryString: request.url.includes("?") ? request.url.split("?")[1]! : null,
      httpVersion: request.raw.httpVersion,
      statusCode: reply.statusCode,
      requestBytes: Number(request.headers["content-length"] ?? 0),
      responseBytes: Number(reply.getHeader("content-length") ?? 0),
      durationMs: String(durationMs),
      userAgentRaw,
      userAgentFingerprint: uaFingerprint,
      referer: request.headers.referer ?? null,
      origin: request.headers.origin ?? null,
      accept: request.headers.accept ?? null,
      acceptLanguage: request.headers["accept-language"] ?? null,
      acceptEncoding: request.headers["accept-encoding"] ?? null,
      contentType: request.headers["content-type"] ?? null,
      forwardedForClientSupplied: (request.headers["x-forwarded-for"] as string) ?? null,
      // Set by Nginx from its own view of the TLS handshake (honeypot-tls.conf), never trusted
      // from the client — same trust boundary as X-Real-IP, see docs/ARCHITECTURE.md §9. Empty
      // string (not absent) on a plain-HTTP connection, hence the explicit blank check.
      tlsVersion: nonEmptyHeader(request.headers["x-tls-version"]),
      tlsCipher: nonEmptyHeader(request.headers["x-tls-cipher"]),
      alpn: nonEmptyHeader(request.headers["x-alpn-protocol"]),
      endpoint: request.hp.endpoint,
      applicationComponent: request.hp.applicationComponent,
      riskScore,
    },
  });

  const eventTypes: EventType[] = ["HTTP_REQUEST", ...inline.additionalEventTypes, ...(request.hp.extraEventTypes as EventType[])];
  if (reply.statusCode >= 400) eventTypes.push("HTTP_ERROR");

  for (const eventType of new Set(eventTypes)) {
    queue.enqueue({
      kind: "event",
      priority: eventType === "CANARY_TRIGGERED" || eventType === "ADMIN_PAGE_ACCESS" || eventType.startsWith("LOGIN") ? "high" : "low",
      row: {
        eventId: randomUUID(),
        createdAt: new Date(),
        requestId,
        actorId,
        sessionId,
        eventType,
        severity: severityFor(eventType, riskScore),
        riskScore,
        source: "inline_rule",
        metadata: { path, method: request.method },
      },
    });
  }

  if (inline.canaryMatches.length > 0) {
    for (const value of inline.canaryMatches) {
      const canary = await findCanaryByValue(value);
      if (!canary) continue;
      await db.insert(schema.canaryEvents).values({
        canaryEventId: randomUUID(),
        canaryId: canary.id,
        actorId,
        requestId,
        createdAt: new Date(),
        usageContext: `${request.method} ${path}`,
      });
      void fireCanaryAlert(actorId, canary.canaryType, canary.plantedLocation, value, queue, request.log);
    }
  }

  recentBuffer.record(actorId, {
    atMs: Date.now(),
    path,
    pathTemplate: request.hp.pathTemplate ?? null,
    pathParams: request.hp.pathParams ?? {},
    method: request.method,
    statusCode: reply.statusCode,
    userAgent: userAgentRaw,
    eventTypes,
    queryParams: request.query as Record<string, string>,
    fetchedDocsFirst: request.hp.fetchedDocsFirst,
    username: request.hp.authEvent?.username,
    authEventType: request.hp.authEvent?.type,
    riskScore,
  });
}

function nonEmptyHeader(value: string | string[] | undefined): string | null {
  const s = Array.isArray(value) ? value[0] : value;
  return s && s.length > 0 ? s : null;
}

function severityFor(eventType: EventType, riskScore: number): "info" | "low" | "medium" | "high" | "critical" {
  if (eventType === "CANARY_TRIGGERED") return "critical";
  if (riskScore >= 60) return "high";
  if (riskScore >= 35) return "medium";
  if (riskScore >= 15) return "low";
  return "info";
}
