import { createMerchantSql } from "@honeypot/merchant-db";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { NetworkLookup, ensureRangesLoaded } from "./sensing.js";
import { startWorkers } from "./scoring/worker.js";
import { dispatchDue } from "./webhooks/dispatcher.js";

async function main() {
  const config = loadConfig();
  const deps = {
    config,
    app: createMerchantSql(config.appDatabaseUrl, 10),
    admin: createMerchantSql(config.adminDatabaseUrl, 4),
    network: NetworkLookup.fromEnv(),
  };
  ensureRangesLoaded();
  const app = await buildApp(deps, { logger: { level: process.env.LOG_LEVEL ?? "info", base: { service: "merchant-api" }, redact: ["req.headers.authorization", "req.headers.cookie"] } });
  if (config.workersEnabled) {
    startWorkers(deps.admin, {
      scorerIntervalMs: config.scorerIntervalMs,
      webhookIntervalMs: config.webhookIntervalMs,
      dispatch: () => dispatchDue(deps.admin, { encryptionKey: config.encryptionKey, allowPrivate: config.allowPrivateWebhookTargets }),
      log: (o) => app.log.warn(o),
    });
  }
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ msg: "merchant-api listening", port: config.port });
}

main().catch((err) => {
  console.error("fatal startup error", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
