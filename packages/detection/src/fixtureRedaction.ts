import type { VisitEvidence } from "./agentScore.js";

/**
 * Redaction for golden visit fixtures, which are committed to a public repository. A raw page-script
 * fingerprint (canvas/audio hashes, font list, exact GPU, full browser versions, battery, media
 * devices) is a stable identifier of the device that made the run — often our own laptops. Keep only
 * what the scorer reads (agentScore.ts, pageConsistency.ts, pageControl.ts) and replace identifying
 * values with placeholders that preserve equality within the visit, so every check scores the same.
 * goldenVisits.test.ts asserts that redaction doesn't change any fixture's verdict.
 */

const NAV_KEEP = ["webdriver", "ua", "platform", "languages", "language", "vendor", "productSub", "buildID", "hardwareConcurrency", "deviceMemory", "plugins", "pdfViewerEnabled", "mimeTypes", "maxTouchPoints"];
const AUTOMATION_KEEP = ["globals", "globalScan", "documentScan", "webdriverGetterNative", "webdriverOwnProp", "fnToStringNative", "cdpRuntime", "chrome", "outerZero"];
const SCREEN_KEEP = ["w", "h", "outerW", "outerH", "innerW", "innerH", "dpr"];
/** Renderer strings the scorer looks for (software_gpu); anything else is replaced. */
const SOFTWARE_GPU = /swiftshader|llvmpipe|software/i;

const pick = (o: unknown, keys: string[]): Record<string, unknown> | undefined => {
  if (!o || typeof o !== "object") return undefined;
  const src = o as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => k in src).map((k) => [k, src[k]]));
};

export function redactFixtureEvidence(ev: VisitEvidence): VisitEvidence {
  // Same input value → same placeholder, so "did the fingerprint change within the visit" survives.
  const aliases = new Map<string, string>();
  const alias = (kind: string, v: unknown) => {
    if (v === null || v === undefined) return v;
    const key = `${kind}:${JSON.stringify(v)}`;
    if (!aliases.has(key)) aliases.set(key, `${kind}-${[...aliases.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1}`);
    return aliases.get(key);
  };
  const stripQuery = (p: unknown) => (typeof p === "string" ? p.split("?")[0] : p);
  const fingerprints = ev.client.fingerprints.map((f) => {
    const webgl = f.webgl && typeof f.webgl === "object"
      ? { supported: f.webgl.supported, webgl2: f.webgl.webgl2, renderer: f.webgl.renderer && SOFTWARE_GPU.test(String(f.webgl.renderer)) ? f.webgl.renderer : alias("gpu", f.webgl.renderer) }
      : f.webgl;
    const uaData = f.uaData && typeof f.uaData === "object"
      ? { platform: f.uaData.platform, mobile: f.uaData.mobile, low: f.uaData.low ? { platform: f.uaData.low.platform, mobile: f.uaData.low.mobile, brands: f.uaData.low.brands } : undefined }
      : f.uaData;
    return {
      nav: pick(f.nav, NAV_KEEP),
      automation: pick(f.automation, AUTOMATION_KEEP),
      webgl,
      screen: pick(f.screen, SCREEN_KEEP),
      intl: f.intl ? { tz: f.intl.tz } : f.intl,
      uaData,
      canvas: alias("canvas", f.canvas),
      doc: f.doc ? { visibility: f.doc.visibility, hasFocus: f.doc.hasFocus } : f.doc,
      globalsDiff: f.globalsDiff,
      artifacts: f.artifacts,
      clientT: f.clientT,
    };
  });
  return {
    ...ev,
    client: { ...ev.client, fingerprints, behaviors: ev.client.behaviors.map((b) => ({ ...b, path: stripQuery(b.path) })) },
    requests: ev.requests.map((r) => ({ ...r, path: stripQuery(r.path) as string })),
  };
}
