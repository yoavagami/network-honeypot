import { and, ilike, or, eq } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { crmDb } from "../crmDb.js";
import { CRM_SEARCH_RESULT_LIMIT } from "./constants.js";

export interface CustomerRow {
  customerId: string;
  orgId: string;
  name: string;
  email: string;
  company: string;
  status: string;
}

/** Normal parameterized query — what a real implementation of this feature would look like. */
export async function searchCustomersSafe(search: string, company?: string): Promise<CustomerRow[]> {
  const conditions = [or(ilike(schema.crmCustomers.name, `%${search}%`), ilike(schema.crmCustomers.email, `%${search}%`), ilike(schema.crmCustomers.company, `%${search}%`))];
  if (company) conditions.push(eq(schema.crmCustomers.company, company));

  const rows = await crmDb
    .select({
      customerId: schema.crmCustomers.customerId,
      orgId: schema.crmCustomers.orgId,
      name: schema.crmCustomers.name,
      email: schema.crmCustomers.email,
      company: schema.crmCustomers.company,
      status: schema.crmCustomers.status,
    })
    .from(schema.crmCustomers)
    .where(and(...conditions))
    .limit(CRM_SEARCH_RESULT_LIMIT);

  return rows;
}
