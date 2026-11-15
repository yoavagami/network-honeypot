import postgres from "postgres";

/**
 * Connections to the merchant database. Timestamps come back as Date, JSON as parsed values
 * (postgres.js defaults — unlike packages/db, which runs drizzle's pass-through serializers).
 */
export function createMerchantSql(url: string, max = 10) {
  const ssl = process.env.DATABASE_SSL === "true" || url.includes("sslmode=require") ? "require" : undefined;
  return postgres(url, { max, ssl, onnotice: () => {}, idle_timeout: 60 });
}
export type MerchantSql = postgres.Sql;
export type MerchantTx = postgres.TransactionSql;

const MERCHANT_RE = /^mer_[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * Runs `fn` in a transaction scoped to one merchant: row-level security (migration 0001) limits
 * every query inside it to that merchant's rows. The merchant id must come from a verified session
 * or API key — never from request input.
 */
export async function withMerchant<T>(sql: MerchantSql, merchantId: string, fn: (tx: MerchantTx) => Promise<T>): Promise<T> {
  if (!MERCHANT_RE.test(merchantId)) throw new Error("withMerchant: invalid merchant id");
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.merchant_id', ${merchantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
