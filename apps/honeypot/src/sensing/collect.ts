import type { FastifyRequest } from "fastify";
import type { InferInsertModel } from "drizzle-orm";
import type { schema } from "@honeypot/db";
import { captureHeaders, consistencyFlags } from "./headers.js";
import { parseUserAgent } from "./userAgent.js";
import { verifyWebBotAuth } from "./webBotAuth.js";
import { agentRangesFor, isTorExit, reverseDns } from "./ipIntel.js";
import { decideIdentity } from "./verdict.js";
import { decodeEdgeHeader } from "./edge.js";

export type RequestSignalsRow = InferInsertModel<typeof schema.requestSignals>;

/**
 * Everything the server can observe about who sent one request, reduced to a request_signals
 * row. Runs from capture.ts's finalizeRequest — after the response has gone out — so the
 * signature check's directory fetch and the rDNS lookup never add visitor-facing latency.
 */
export async function collectRequestSignals(request: FastifyRequest, requestId: string, createdAt: Date): Promise<RequestSignalsRow> {
  const { actorId, sessionId, ip, labLabel } = request.hp;
  const rawUa = (request.headers["user-agent"] as string | undefined) ?? null;
  const headers = captureHeaders(request.raw.rawHeaders);
  const ua = parseUserAgent(rawUa);
  const edge = decodeEdgeHeader(request.headers["x-hp-edge"]);
  const isHttps = request.headers["x-forwarded-proto"] === "https";

  const headerLookup = (name: string): string[] => {
    const out: string[] = [];
    const raw = request.raw.rawHeaders;
    for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) out.push(raw[i + 1]!);
    return out;
  };
  const wba = await verifyWebBotAuth({
    method: request.method,
    url: request.url,
    host: (request.headers.host as string | undefined) ?? "",
    header: headerLookup,
  });

  const ipRanges = ip ? agentRangesFor(ip) : [];
  const needsRdns = Boolean(ua.claim?.rdnsSuffixes) || ipRanges.length === 0;
  const rdns = ip && needsRdns ? await reverseDns(ip) : null;
  const tor = ip ? isTorExit(ip) : false;

  const flags = consistencyFlags(headers, ua, isHttps, edge ? {
    hasGrease: edge.hello?.grease,
    alpnOffered: edge.hello?.alpn,
    pseudoOrder: edge.h2?.pseudoOrder ?? null,
  } : null);
  const identity = decideIdentity({ ua, rawUa, ipRanges, rdns, wba, consistencyFlags: flags });

  return {
    requestId,
    createdAt,
    actorId,
    sessionId,
    labLabel: labLabel ?? null,
    labVerified: request.hp.labVerified ?? false,
    pageLoadId: request.hp.pageLoadId ?? null,
    ja4: edge?.ja4 ?? null,
    ja3nHash: edge?.ja3n_hash ?? null,
    h2Fp: edge?.h2?.fp ?? null,
    headerOrderHash: headers.orderHash,
    uaClaim: ua.claim?.id ?? null,
    uaLibrary: ua.library,
    wbaStatus: wba.status,
    wbaSigner: wba.signer,
    identityVerdict: identity.verdict,
    identityAgent: identity.agent,
    ipAgentRange: ipRanges[0] ?? null,
    ipTor: tor,
    data: {
      identity,
      ua: { aiApp: ua.aiApp, browser: ua.browser, platform: ua.platform, claimOperator: ua.claim?.operator ?? null },
      headers: { order: headers.order, values: headers.values, cookieNames: headers.cookieNames },
      consistencyFlags: flags,
      wba,
      ip: { ranges: ipRanges, tor, rdns },
      edge,
      pageLoadId: request.hp.pageLoadId ?? null,
    },
  };
}
