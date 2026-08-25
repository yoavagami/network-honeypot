-- Synthetic "CRM" feature — a customers/orgs/orders/integrations dataset backing a deliberately
-- vulnerable search endpoint (see apps/honeypot/src/routes/crm.ts and docs/VULNERABILITY.md).
-- Entirely additive: does not touch any existing table. Kept in its own tightly-scoped role
-- (honeypot_crm_role, granted below) so even a total logic failure in the vulnerable code path
-- can only ever read these six tables — never actors/requests/events/admin_users. See
-- docs/ARCHITECTURE.md §3 / docs/SECURITY.md §3 for the existing least-privilege pattern this
-- extends.

CREATE TABLE crm_organizations (
  org_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  industry       text NOT NULL,
  plan           text NOT NULL,
  account_status text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm_customers (
  customer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES crm_organizations (org_id) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text NOT NULL,
  company     text NOT NULL,
  status      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_customers_org ON crm_customers (org_id);

CREATE TABLE crm_users (
  user_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES crm_organizations (org_id) ON DELETE CASCADE,
  email          text NOT NULL,
  role           text NOT NULL,
  internal_notes text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_users_org ON crm_users (org_id);

CREATE TABLE crm_orders (
  order_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES crm_customers (customer_id) ON DELETE CASCADE,
  amount      numeric(10, 2) NOT NULL,
  status      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_orders_customer ON crm_orders (customer_id);

CREATE TABLE crm_invoices (
  invoice_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES crm_orders (order_id) ON DELETE CASCADE,
  amount     numeric(10, 2) NOT NULL,
  status     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_invoices_order ON crm_invoices (order_id);

CREATE TABLE crm_api_integrations (
  integration_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES crm_organizations (org_id) ON DELETE CASCADE,
  provider       text NOT NULL,
  api_key        text NOT NULL,
  webhook_url    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_integrations_org ON crm_api_integrations (org_id);

-- honeypot_crm_role: SELECT-only, only on the six tables above. Nothing else — not
-- actors/requests/events/canary_objects/admin_users. This is the role the vulnerable search
-- code path connects as; every other honeypot code path keeps using honeypot_role, unaffected.
GRANT SELECT ON crm_organizations, crm_customers, crm_users, crm_orders, crm_invoices, crm_api_integrations
  TO honeypot_crm_role;
