import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "@honeypot/db";

/**
 * Seeds the synthetic CRM dataset backing the deliberately vulnerable search endpoint — see
 * docs/VULNERABILITY.md and migrations/0005_crm_customers.sql. Separate from scripts/seed.ts
 * (and not run by default) since this data only matters when CRM_SEARCH_VULNERABLE is actually
 * in use. Run with a superuser/owner DATABASE_URL — honeypot_crm_role is SELECT-only and can't
 * write this data itself. Idempotent: skips entirely if crm_organizations already has rows.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const requiresSsl = process.env.DATABASE_SSL === "true" || connectionString.includes("sslmode=require");
const client = postgres(connectionString, { max: 1, ssl: requiresSsl ? "require" : undefined });
const db = drizzle(client, { schema });

const COMPANY_WORDS = [
  "Acme", "Northwind", "Globex", "Initech", "Umbrella", "Stark", "Wayne", "Wonka", "Hooli", "Massive",
  "Pinnacle", "Vertex", "Nimbus", "Quantum", "Cobalt", "Lumen", "Apex", "Zenith", "Orbit", "Catalyst",
  "Meridian", "Beacon", "Horizon", "Anchor", "Sable", "Iron", "Cedar", "Maple", "Granite", "Slate",
];
const COMPANY_SUFFIXES = [
  "Corp", "Inc", "LLC", "Group", "Solutions", "Systems", "Labs", "Technologies", "Partners", "Holdings",
  "Industries", "Networks", "Dynamics", "Ventures", "Works",
];
const FIRST_NAMES = [
  "Alice", "Ben", "Priya", "Sam", "Jordan", "Maria", "Tom", "Yuki", "Chen", "Diego", "Fatima", "Noah",
  "Elena", "Kwame", "Sofia", "Liam", "Amara", "Ravi", "Nina", "Omar", "Grace", "Hiro", "Ines", "Malik",
  "Zara", "Felix", "Anya", "Leo", "Mei", "Victor",
];
const LAST_NAMES = [
  "Chen", "Torres", "Nair", "Okafor", "Lee", "Silva", "Becker", "Tanaka", "Rossi", "Kim", "Haddad",
  "Novak", "Petrov", "Abara", "Sato", "Reyes", "Nilsson", "Farah", "Costa", "Weber", "Park", "Diallo",
  "Moreau", "Iyer", "Nakamura", "Osei", "Vargas", "Lindqvist", "Hassan", "Berg",
];
const INDUSTRIES = [
  "SaaS", "Fintech", "Healthcare", "E-commerce", "Logistics", "Manufacturing", "EdTech", "Insurance",
  "Real Estate", "Media", "Telecom", "Legal", "Hospitality", "Energy", "Nonprofit",
];
const PLANS = ["Free", "Starter", "Pro", "Business", "Enterprise"];
const ORG_STATUSES = ["active", "trial", "past_due", "churned", "suspended"];
const CUSTOMER_STATUSES = ["active", "trial", "churned", "past_due"];
const CRM_ROLES = ["owner", "admin", "billing_admin", "member", "viewer"];
const ORDER_STATUSES = ["paid", "pending", "refunded", "failed"];
const INVOICE_STATUSES = ["paid", "open", "overdue", "void"];
const PROVIDERS = ["Stripe", "Slack", "Salesforce", "HubSpot", "Zendesk", "Segment", "Twilio", "SendGrid", "Datadog", "PagerDuty"];
const NOTE_TEMPLATES = [
  "Renewal call scheduled — flagged as at-risk for churn.",
  "VIP account, escalate directly to account manager.",
  "Billing dispute opened, awaiting finance review.",
  "Requested SSO — pending Enterprise plan upgrade.",
  "Onboarding stalled, follow up next week.",
  "Expansion opportunity — considering additional seats.",
  "Support ticket backlog, needs manager attention.",
  "Contract up for renewal in 30 days.",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function companyName(): string {
  return `${pick(COMPANY_WORDS)} ${pick(COMPANY_SUFFIXES)}`;
}
function personName(): { first: string; last: string } {
  return { first: pick(FIRST_NAMES), last: pick(LAST_NAMES) };
}
function pastDate(maxDaysAgo: number): Date {
  return new Date(Date.now() - randomInt(0, maxDaysAgo) * 24 * 60 * 60 * 1000);
}

const ORG_COUNT = 50;
const CUSTOMERS_PER_ORG = [20, 60] as const;
const USERS_PER_ORG = [3, 9] as const;
const ORDERS_PER_CUSTOMER = [0, 3] as const;
const INTEGRATIONS_PER_ORG = [1, 2] as const;

async function main() {
  const [existing] = await db.select({ n: schema.crmOrganizations.orgId }).from(schema.crmOrganizations).limit(1);
  if (existing) {
    console.log("crm_organizations already seeded — skipping");
    await client.end();
    return;
  }

  const organizations = Array.from({ length: ORG_COUNT }, () => ({
    orgId: randomUUID(),
    name: companyName(),
    industry: pick(INDUSTRIES),
    plan: pick(PLANS),
    accountStatus: pick(ORG_STATUSES),
    createdAt: pastDate(730),
  }));
  await db.insert(schema.crmOrganizations).values(organizations);
  console.log(`seeded ${organizations.length} organizations`);

  const customers: (typeof schema.crmCustomers.$inferInsert)[] = [];
  const crmUsers: (typeof schema.crmUsers.$inferInsert)[] = [];
  const integrations: (typeof schema.crmApiIntegrations.$inferInsert)[] = [];
  const canaryRows: (typeof schema.canaryObjects.$inferInsert)[] = [];

  for (const org of organizations) {
    const customerCount = randomInt(...CUSTOMERS_PER_ORG);
    for (let i = 0; i < customerCount; i++) {
      const { first, last } = personName();
      const company = companyName();
      customers.push({
        customerId: randomUUID(),
        orgId: org.orgId,
        name: `${first} ${last}`,
        email: `${first.toLowerCase()}.${last.toLowerCase()}@${company.toLowerCase().replace(/\s+/g, "")}.example`,
        company,
        status: pick(CUSTOMER_STATUSES),
        createdAt: pastDate(600),
      });
    }

    const userCount = randomInt(...USERS_PER_ORG);
    for (let i = 0; i < userCount; i++) {
      const { first, last } = personName();
      crmUsers.push({
        userId: randomUUID(),
        orgId: org.orgId,
        email: `${first.toLowerCase()}.${last.toLowerCase()}@${org.name.toLowerCase().replace(/\s+/g, "")}.example`,
        role: pick(CRM_ROLES),
        internalNotes: Math.random() < 0.6 ? pick(NOTE_TEMPLATES) : null,
        createdAt: pastDate(700),
      });
    }

    const integrationCount = randomInt(...INTEGRATIONS_PER_ORG);
    const providers = [...PROVIDERS].sort(() => Math.random() - 0.5).slice(0, integrationCount);
    for (const provider of providers) {
      // Realistic-looking synthetic key — planted as a canary so if it's ever reused elsewhere
      // (e.g. against /api/v1/config or another endpoint) the existing canary-trigger detection
      // catches it automatically. See packages/detection/src/rules/inline/canary.ts.
      const apiKey = `sk_live_${randomUUID().replace(/-/g, "").slice(0, 32)}`;
      const integrationId = randomUUID();
      integrations.push({
        integrationId,
        orgId: org.orgId,
        provider,
        apiKey,
        webhookUrl: `https://hooks.${provider.toLowerCase()}.example/in/${randomUUID().slice(0, 8)}`,
        createdAt: pastDate(500),
      });
      canaryRows.push({
        canaryId: randomUUID(),
        canaryType: "api_key",
        value: apiKey,
        plantedLocation: `crm_api_integrations.api_key (org ${org.name}, ${provider})`,
        createdAt: new Date(),
        active: true,
      });
    }
  }

  // postgres.js has a bind-parameter limit per query — chunk large bulk inserts.
  async function insertInChunks<T extends Record<string, unknown>>(table: Parameters<typeof db.insert>[0], rows: T[], chunkSize = 500) {
    for (let i = 0; i < rows.length; i += chunkSize) {
      await db.insert(table).values(rows.slice(i, i + chunkSize) as never);
    }
  }

  await insertInChunks(schema.crmCustomers, customers);
  console.log(`seeded ${customers.length} customers`);

  await insertInChunks(schema.crmUsers, crmUsers);
  console.log(`seeded ${crmUsers.length} crm users`);

  await insertInChunks(schema.crmApiIntegrations, integrations);
  console.log(`seeded ${integrations.length} api integrations`);

  await insertInChunks(schema.canaryObjects, canaryRows);
  console.log(`planted ${canaryRows.length} canary api keys`);

  const orders: (typeof schema.crmOrders.$inferInsert)[] = [];
  for (const customer of customers) {
    const orderCount = randomInt(...ORDERS_PER_CUSTOMER);
    for (let i = 0; i < orderCount; i++) {
      orders.push({
        orderId: randomUUID(),
        customerId: customer.customerId as string,
        amount: (randomInt(500, 500000) / 100).toFixed(2),
        status: pick(ORDER_STATUSES),
        createdAt: pastDate(400),
      });
    }
  }
  await insertInChunks(schema.crmOrders, orders);
  console.log(`seeded ${orders.length} orders`);

  const invoices: (typeof schema.crmInvoices.$inferInsert)[] = orders.map((order) => ({
    invoiceId: randomUUID(),
    orderId: order.orderId as string,
    amount: order.amount as string,
    status: order.status === "paid" ? "paid" : pick(INVOICE_STATUSES),
    createdAt: order.createdAt as Date,
  }));
  await insertInChunks(schema.crmInvoices, invoices);
  console.log(`seeded ${invoices.length} invoices`);

  console.log("done");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
