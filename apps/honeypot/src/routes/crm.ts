import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { searchCustomersSafe } from "../crm/searchSafe.js";
import { searchCustomersUnsafe } from "../crm/searchUnsafe.js";
import { CRM_SEARCH_RESULT_LIMIT } from "../crm/constants.js";
import { customersPage } from "../render/pages.js";

interface CustomersQuery {
  search?: string;
  company?: string;
}

async function runSearch(search: string, company?: string) {
  if (!config.crmSearchVulnerable) {
    const rows = await searchCustomersSafe(search, company);
    return { rows: rows as unknown as Record<string, unknown>[], pgError: undefined as { code: string; message: string } | undefined };
  }
  const outcome = await searchCustomersUnsafe(search, company);
  return { rows: outcome.rows, pgError: outcome.pgError };
}

/**
 * Behavioral SQLi detection — deliberately not string-matching the input (see docs/VULNERABILITY.md
 * §"detection philosophy"). Two independent, unambiguous signals derived from what the database
 * actually did:
 *   - a real Postgres error came back (SQLI_PROBE) — proves the input broke query parsing, which
 *     safe/parameterized input structurally cannot do.
 *   - more rows came back than CRM_SEARCH_RESULT_LIMIT (SQLI_CONFIRMED + DATA_EXTRACTION) — the
 *     query's own LIMIT makes this physically impossible unless something bypassed it (comment
 *     truncation, UNION). Only meaningful when the vulnerable path is actually active — the safe
 *     path can structurally never trigger either.
 */
const RESPONSE_SAMPLE_SIZE = 10;

function recordSqliTelemetry(request: FastifyRequest, result: { rows: Record<string, unknown>[]; pgError?: { code: string; message: string } }) {
  if (!config.crmSearchVulnerable) return;
  if (result.pgError) {
    request.hp.extraEventTypes.push("SQLI_PROBE");
    request.hp.extraRiskFlags.push("sqliProbe");
    request.hp.extraEventMetadata.pgError = result.pgError;
    return;
  }
  if (result.rows.length > CRM_SEARCH_RESULT_LIMIT) {
    request.hp.extraEventTypes.push("SQLI_CONFIRMED", "DATA_EXTRACTION");
    request.hp.extraRiskFlags.push("sqliConfirmed");
    // The actual response content isn't captured anywhere else in the pipeline (requests only
    // logs response_bytes, a count) — this is the one place "what did they actually walk away
    // with" becomes answerable from the dashboard. Sampled, not the full dump: a bypassed query
    // can return thousands of rows, and this lands in jsonb.
    request.hp.extraEventMetadata.rowCount = result.rows.length;
    request.hp.extraEventMetadata.responseSample = result.rows.slice(0, RESPONSE_SAMPLE_SIZE);
  }
}

export function registerCrmRoutes(app: FastifyInstance) {
  app.get("/customers", async (request, reply) => {
    request.hp.endpoint = "site.customers";
    request.hp.applicationComponent = "crm";
    const q = request.query as CustomersQuery;
    const search = String(q.search ?? "");
    const company = q.company ? String(q.company) : undefined;
    request.hp.canaryHaystacks.push(search, company ?? "");

    let rows: Array<Record<string, unknown>> = [];
    if (search) {
      const result = await runSearch(search, company);
      recordSqliTelemetry(request, result);
      rows = result.rows;
      // Real production apps don't echo raw DB errors — same generic failure either way,
      // whether the underlying cause was a genuine bug or someone's injection attempt.
      if (result.pgError) {
        reply.type("text/html").status(500).send(customersPage({ search, company, rows: [], error: true }));
        return;
      }
    }
    reply.type("text/html").send(customersPage({ search, company, rows, error: false }));
  });

  app.get("/api/v1/customers", async (request, reply) => {
    request.hp.endpoint = "api.customers.search";
    request.hp.applicationComponent = "crm";
    request.hp.extraEventTypes.push("API_REQUEST");
    const q = request.query as CustomersQuery;
    const search = String(q.search ?? "");
    const company = q.company ? String(q.company) : undefined;
    request.hp.canaryHaystacks.push(search, company ?? "");

    if (!search) {
      reply.status(400).send({ error: { code: "invalid_parameter", message: "search is required" } });
      request.hp.paramValidationFailed = true;
      return;
    }

    const result = await runSearch(search, company);
    recordSqliTelemetry(request, result);
    if (result.pgError) {
      reply.status(500).send({ error: { code: "internal_error", message: "Something went wrong processing your request." } });
      return;
    }
    reply.send({ data: result.rows, total: result.rows.length });
  });
}
