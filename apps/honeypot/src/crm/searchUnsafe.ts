import { crmClient } from "../crmDb.js";
import { CRM_SEARCH_RESULT_LIMIT } from "./constants.js";

export interface UnsafeSearchOutcome {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** Set only when Postgres itself rejected the query — real DB behavior, not a guess based on
   * the input text. This is the behavioral signal detection (Phase 7) keys off, never shown to
   * the caller verbatim. */
  pgError?: { code: string; message: string };
}

/**
 * The deliberately vulnerable implementation — gated behind config.crmSearchVulnerable, see
 * routes/crm.ts. Builds the query via raw string interpolation and executes it through
 * postgres.js's `.unsafe()`, which bypasses parameterization entirely. This is a genuine SQL
 * injection: a `'` in `search` breaks out of the string literal, `--` truncates the rest of the
 * query (including the LIMIT), and a matching-arity UNION SELECT can pull rows from any table
 * honeypot_crm_role can read. See docs/VULNERABILITY.md.
 */
export async function searchCustomersUnsafe(search: string, company?: string): Promise<UnsafeSearchOutcome> {
  let query = `SELECT customer_id, org_id, name, email, company, status FROM crm_customers WHERE name ILIKE '%${search}%' OR email ILIKE '%${search}%' OR company ILIKE '%${search}%'`;
  if (company) query += ` AND company = '${company}'`;
  query += ` LIMIT ${CRM_SEARCH_RESULT_LIMIT}`;

  try {
    const rows = await crmClient.unsafe(query);
    return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
  } catch (err) {
    const pgErr = err as { code?: string; message?: string };
    return { rows: [], rowCount: 0, pgError: { code: pgErr.code ?? "unknown", message: pgErr.message ?? String(err) } };
  }
}
