import { createDbClient } from "@honeypot/db";
import { config } from "./config.js";

/**
 * Separate connection for the CRM search feature (docs/VULNERABILITY.md), deliberately never
 * shared with apps/honeypot/src/db.ts's main client — connects as honeypot_crm_role, which
 * (migrations/0005_crm_customers.sql) can only SELECT the six crm_* tables. Both the safe and
 * vulnerable search implementations use this same connection; `client` (the raw `postgres` tag
 * function) is what the vulnerable path uses for `.unsafe()` — see routes/crm.ts.
 */
export const { db: crmDb, client: crmClient } = createDbClient({ connectionString: config.crmDatabaseUrl, max: 5 });
