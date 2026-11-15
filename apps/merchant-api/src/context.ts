import type { MerchantSql } from "@honeypot/merchant-db";
import type { MerchantConfig } from "./config.js";
import type { NetworkLookup } from "./sensing.js";

export interface Deps {
  config: MerchantConfig;
  /** merchant_app: public API + merchant dashboard (row-level security, one merchant per transaction). */
  app: MerchantSql;
  /** merchant_admin: internal admin endpoints and workers. */
  admin: MerchantSql;
  network: NetworkLookup;
}
