import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import * as C from "../src/index.js";

const spec = JSON.parse(readFileSync(fileURLToPath(new URL("../openapi.json", import.meta.url)), "utf8"));
const ID = "https://uhoney.shop/openapi.json";
const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
(addFormats as any)(ajv);
ajv.addSchema({ $id: ID, components: spec.components });

const validator = (name: string) => {
  const v = ajv.getSchema(`${ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`no schema ${name}`);
  return v;
};
const resolve = (ref: string) => ref.replace(/^#\//, "").split("/").reduce((o: any, k) => o[k], spec);
const exampleValue = (e: any) => (e.$ref ? resolve(e.$ref) : e).value;
const schemaName = (s: any): string | null => (s?.$ref ? s.$ref.split("/").pop() : null);

/** Every (schema, example) pair the spec declares, in request bodies, responses and webhooks. */
function declaredExamples(): Array<{ where: string; schema: string; value: unknown }> {
  const out: Array<{ where: string; schema: string; value: unknown }> = [];
  const media = (where: string, content: any) => {
    for (const [type, m] of Object.entries<any>(content ?? {})) {
      const name = schemaName(m.schema);
      for (const [ex, e] of Object.entries<any>(m.examples ?? {})) if (name) out.push({ where: `${where} ${type} ${ex}`, schema: name, value: exampleValue(e) });
    }
  };
  const op = (where: string, o: any) => {
    media(`${where} request`, o.requestBody?.content);
    for (const [code, r] of Object.entries<any>(o.responses ?? {})) media(`${where} ${code}`, (r.$ref ? resolve(r.$ref) : r).content);
  };
  for (const [p, item] of Object.entries<any>(spec.paths)) for (const [m, o] of Object.entries<any>(item)) op(`${m.toUpperCase()} ${p}`, o);
  for (const [name, item] of Object.entries<any>(spec.webhooks)) op(`webhook ${name}`, item.post);
  return out;
}

describe("merchant API contract", () => {
  const examples = declaredExamples();

  it("declares examples for every operation", () => {
    expect(examples.length).toBeGreaterThanOrEqual(14);
  });

  it.each(examples.map((e) => [e.where, e] as const))("example matches its schema: %s", (_w, e) => {
    const v = validator(e.schema);
    const ok = v(e.value);
    expect(ok, JSON.stringify(v.errors)).toBe(true);
  });

  it("runtime request schemas accept the spec's request examples", () => {
    const parsers: Record<string, { safeParse: (x: unknown) => { success: boolean; error?: unknown } }> = {
      CollectRequest: C.collectRequest,
      AssessRequest: C.assessRequest,
      FeedbackRequest: C.feedbackRequest,
    };
    let checked = 0;
    for (const e of examples) {
      const p = parsers[e.schema];
      if (!p) continue;
      const r = p.safeParse(e.value);
      expect(r.success, `${e.where}: ${JSON.stringify(r.error)}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it("enums in the spec equal the runtime constants", () => {
    const s = spec.components.schemas;
    expect(s.Driver.enum).toEqual([...C.DRIVERS]);
    expect(s.Assessment.properties.suggested_action.enum).toEqual([...C.SUGGESTED_ACTIONS]);
    expect(s.Assessment.properties.decision.enum).toEqual([...C.DECISIONS]);
    expect(s.Assessment.properties.intent.properties.status.enum).toEqual([...C.INTENT_STATUSES]);
    expect(s.AssessmentUpdatedEvent.allOf[1].properties.data.properties.previous.properties.decision.enum).toEqual([...C.DECISIONS]);
    expect(s.Order.properties.payment.properties.method.enum).toEqual([...C.PAYMENT_METHODS]);
    expect(s.Assessment.properties.confidence.enum).toEqual([...C.CONFIDENCE]);
    expect(s.Assessment.properties.automation_type.enum).toEqual([...C.AUTOMATION_TYPES]);
    expect(s.Agent.properties.verification.enum.filter(Boolean)).toEqual([...C.VERIFICATION_METHODS]);
    expect(s.AssessRequest.properties.stage.enum).toEqual([...C.ASSESS_STAGES]);
    expect(s.FeedbackRequest.properties.outcome.enum).toEqual([...C.FEEDBACK_OUTCOMES]);
    expect(s.IntegrationStatus.properties.checks.items.properties.id.enum).toEqual([...C.STATUS_CHECKS]);
    expect(s.IntegrationStatus.properties.checks.items.properties.status.enum).toEqual([...C.CHECK_STATES]);
    expect(s.EventEnvelope.properties.type.enum).toEqual([...C.WEBHOOK_EVENTS]);
    expect(Object.keys(spec.webhooks)).toEqual([...C.WEBHOOK_EVENTS]);
    expect(s.Error.properties.error.properties.code.enum).toEqual([...C.ERROR_CODES]);
    expect(s.CollectRequest.properties.kind.enum).toEqual([...C.collectRequest.shape.kind.options]);
  });

  it("id patterns in the spec equal the runtime patterns", () => {
    const s = spec.components.schemas;
    expect(new RegExp(s.MerchantId.pattern).source).toBe(C.ID_PATTERNS.merchant.source);
    expect(new RegExp(s.SessionToken.pattern).source).toBe(C.ID_PATTERNS.sessionToken.source);
    expect(new RegExp(s.AssessmentId.pattern).source).toBe(C.ID_PATTERNS.assessment.source);
    expect(new RegExp(s.CollectRequest.properties.site_key.pattern).source).toBe(C.ID_PATTERNS.siteKey.source);
  });

  it("every error code has an HTTP status the spec allows for some operation", () => {
    const allowed = new Set<string>();
    for (const item of Object.values<any>(spec.paths)) for (const o of Object.values<any>(item)) for (const code of Object.keys(o.responses)) allowed.add(code);
    for (const [code, status] of Object.entries(C.ERROR_STATUS)) expect(allowed.has(String(status)), `${code} → ${status}`).toBe(true);
  });

  it("rejects malformed requests in both the spec and the runtime schemas", () => {
    const bad: Array<[string, unknown, { safeParse: (x: unknown) => { success: boolean } }]> = [
      ["AssessRequest", { request: { ip: "203.0.113.7", user_agent: null } }, C.assessRequest],
      ["AssessRequest", { order: { id: "o", amount: 1.5, currency: "EUR" }, request: { ip: "203.0.113.7", user_agent: null } }, C.assessRequest],
      ["AssessRequest", { order: { id: "o", amount: 1, currency: "eur" }, request: { ip: "203.0.113.7", user_agent: null } }, C.assessRequest],
      ["AssessRequest", { order: { id: "o", amount: 1, currency: "EUR" }, request: { ip: "not-an-ip", user_agent: null } }, C.assessRequest],
      ["AssessRequest", { order: { id: "o", amount: 1, currency: "EUR" }, request: { ip: "203.0.113.7", user_agent: null, headers: { "Accept": "x" } } }, C.assessRequest],
      ["AssessRequest", { order: { id: "o", amount: 1, currency: "EUR", items: [{ sku: "a", quantity: 0, unit_amount: 1 }] }, request: { ip: "203.0.113.7", user_agent: null } }, C.assessRequest],
      ["AssessRequest", { order: { id: "o", amount: 1, currency: "EUR", items: [{ sku: "a", quantity: 1, unit_amount: 1, category: "Gift Cards" }] }, request: { ip: "203.0.113.7", user_agent: null } }, C.assessRequest],
      ["AssessRequest", { order: { id: "o", amount: 1, currency: "EUR", shipping: { country: "nl" } }, request: { ip: "203.0.113.7", user_agent: null } }, C.assessRequest],
      ["AssessRequest", { order: { id: "o", amount: 1, currency: "EUR", shipping: { address_hash: "1 Main St" } }, request: { ip: "203.0.113.7", user_agent: null } }, C.assessRequest],
      ["AssessRequest", { order: { id: "o", amount: 1, currency: "EUR", payment: { method: "cash" } }, request: { ip: "203.0.113.7", user_agent: null } }, C.assessRequest],
      ["AssessRequest", { order: { id: "o", amount: 1, currency: "EUR" }, intent_ref: "has spaces", request: { ip: "203.0.113.7", user_agent: null } }, C.assessRequest],
      ["FeedbackRequest", { order_id: "o", assessment_id: "as_9fK2aB7cD1eF3gH5iJ6k", outcome: "fraud" }, C.feedbackRequest],
      ["FeedbackRequest", { outcome: "fraud" }, C.feedbackRequest],
      ["CollectRequest", { site_key: "sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", kind: "page" }, C.collectRequest],
      ["CollectRequest", { site_key: "pk_test_4fQ8mN2xR7vK1pL9sT3wY6zB", kind: "keystrokes" }, C.collectRequest],
    ];
    for (const [schema, value, zod] of bad) {
      expect(validator(schema)(value), `spec accepted ${JSON.stringify(value)}`).toBe(false);
      expect(zod.safeParse(value).success, `runtime accepted ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("the default policy never suggests more than review", () => {
    expect(Object.values(C.DEFAULT_POLICY)).not.toContain("challenge");
  });

  it("the default policy never blocks", () => {
    expect(C.DEFAULT_POLICY.block_when).toEqual([]);
  });
});
