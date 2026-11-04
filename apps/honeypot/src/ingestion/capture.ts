import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { schema } from "@honeypot/db";
import { hashIp, resolveClientIp, userAgentFingerprint, evaluateInline, computeEventRiskScore, type RiskFlag } from "@honeypot/detection";
import type { EventType } from "@honeypot/types";
import { db } from "../db.js";
import { config } from "../config.js";
import { resolveActor, resolveSession } from "./correlation.js";
import { getActiveCanaryValues, findCanaryByValue } from "./canaries.js";
import { fireCanaryAlert } from "./alerts.js";
import { recentBuffer } from "./recentBuffer.js";
import { metrics } from "./metrics.js";
import { enrichActorIfNeeded } from "./enrichment.js";
import { prepareRequestBody } from "../bodyRedaction.js";
import type { IngestionQueue } from "./queue.js";
import { collectRequestSignals } from "../sensing/collect.js";
import { decodeEdgeHeader } from "../sensing/edge.js";
import "../context.js";

const VISITOR_COOKIE = "hp_visitor";
const SESSION_COOKIE = "hp_session";
const LAB_COOKIE = "hp_lab";
const LAB_LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

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
        extraRiskFlags: [],
        extraEventMetadata: {},
        startedAtMs: Date.now(),
        visitorId: "",
        actorId: "",
        sessionId: "",
        ip: "",
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
      extraRiskFlags: [],
      extraEventMetadata: {},
      startedAtMs: Date.now(),
      visitorId: "",
      actorId: "",
      sessionId: "",
      ip: "",
      ipHash: "",
      uaFingerprint: "",
    };

    let visitorId = request.cookies[VISITOR_COOKIE];
    if (!visitorId) {
      visitorId = randomUUID();
      reply.setCookie(VISITOR_COOKIE, visitorId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
    }
    request.hp.visitorId = visitorId;

    // Controlled agent test runs: ?lab=<label> tags this browser for 30 days so every later
    // request/beacon from it is labeled ground truth (agents that drop cookies are labeled on
    // their first request only — analysis regroups those by IP + fingerprint).
    const labParam = (request.query as Record<string, unknown>)?.lab;
    if (typeof labParam === "string" && LAB_LABEL_RE.test(labParam)) {
      request.hp.labLabel = labParam;
      reply.setCookie(LAB_COOKIE, labParam, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
    } else {
      const labCookie = request.cookies[LAB_COOKIE];
      request.hp.labLabel = labCookie && LAB_LABEL_RE.test(labCookie) ? labCookie : null;
    }

    const ip = resolveClientIp(request.ip, request.headers["cf-connecting-ip"], config.trustCfConnectingIp);
    const ipHash = hashIp(ip, config.ipHashSecret);
    const userAgentRaw = request.headers["user-agent"] ?? null;
    const uaFingerprint = userAgentFingerprint(userAgentRaw);
    request.hp.ip = ip;
    request.hp.ipHash = ipHash;
    request.hp.uaFingerprint = uaFingerprint;

    const { actorId } = await resolveActor({ visitorId, ipHash, uaFingerprint });
    request.hp.actorId = actorId;

    // Deliberately not awaited — enrichment is an external HTTP call and must never sit on the
    // request path (see docs/ARCHITECTURE.md §5 / packages/detection/src/enrichment.ts). A slow
    // or failing provider only delays when the actor's country/ASN appear in the dashboard,
    // never the visitor's response. The .catch() matters even though it only logs — an unhandled
    // rejection here crashes the whole process (found live for the same pattern in
    // correlationWorker.ts/canaries.ts — see docs/ROADMAP.md Phase 4).
    enrichActorIfNeeded(ip, actorId).catch((err) => {
      request.log.warn({ msg: "actor enrichment failed", err: err instanceof Error ? err.message : String(err) });
    });

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
  const { actorId, sessionId, ip, ipHash, uaFingerprint } = request.hp;

  if (!actorId) {
    // onRequest's resolveActor() never completed (e.g. Postgres was briefly unreachable), so
    // request.hp.actorId is still its unset "" placeholder. Recording telemetry under that would
    // fail every DB insert (actor_id is a NOT NULL FK) *and* poison recentBuffer with an entry
    // no correlation query can resolve — found live: this aborted the correlation tick for every
    // other actor too, not just this request, for up to recentBuffer's 15-minute window. Dropping
    // here is the same trade-off already accepted for Nginx-level rejections (docs/ROADMAP.md) —
    // an unrecorded request during an outage, not corrupted shared state afterward.
    metrics.eventsDroppedTotal += 1;
    request.log.warn({ msg: "dropping telemetry: actor resolution did not complete for this request" });
    return;
  }
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
    host: request.headers.host ?? "",
  });

  const riskFlags: RiskFlag[] = [...inline.riskFlags, ...request.hp.extraRiskFlags];
  const riskScore = computeEventRiskScore(riskFlags);

  const requestId = randomUUID();
  const path = request.url.split("?")[0]!;
  const edge = decodeEdgeHeader(request.headers["x-hp-edge"]);

  queue.enqueue({
    kind: "request",
    priority: inline.canaryMatches.length > 0 ? "high" : "low",
    row: {
      requestId,
      createdAt: new Date(),
      actorId,
      sessionId,
      ipHash,
      ipRaw: ip,
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
      requestBody: prepareRequestBody(path, request.body),
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
      // Behind the edge sensor, nginx sees plain HTTP — the negotiated TLS facts come from the
      // sensor's own handshake instead (sensing/edge.ts).
      tlsVersion: nonEmptyHeader(request.headers["x-tls-version"]) ?? edge?.negotiated?.version ?? null,
      tlsCipher: nonEmptyHeader(request.headers["x-tls-cipher"]) ?? edge?.negotiated?.cipher ?? null,
      alpn: nonEmptyHeader(request.headers["x-alpn-protocol"]) ?? edge?.negotiated?.alpn ?? null,
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
        metadata: { path, method: request.method, ...request.hp.extraEventMetadata },
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

  // Agent sensing — not awaited: a signature directory fetch or rDNS lookup can take seconds
  // and must not hold up the request/event rows above.
  collectRequestSignals(request, requestId, new Date())
    .then((row) => queue.enqueue({ kind: "request_signals", priority: "low", row }))
    .catch((err) => request.log.warn({ msg: "request signal collection failed", err: err instanceof Error ? err.message : String(err) }));
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
