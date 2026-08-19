import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { config } from "./config.js";
import { IngestionQueue } from "./ingestion/queue.js";
import { registerIngestion } from "./ingestion/capture.js";
import { startCorrelationWorker } from "./ingestion/correlationWorker.js";
import { startHealthMonitor } from "./ingestion/healthMonitor.js";
import { refreshCanaries, startCanaryRefresh } from "./ingestion/canaries.js";
import { snapshotMetrics } from "./ingestion/metrics.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerMiscRoutes } from "./routes/misc.js";
import { registerNotFoundHandler } from "./routes/notFound.js";

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      base: { service: "honeypot" },
      redact: { paths: ["req.headers.cookie", "req.headers.authorization"], censor: "[redacted]" },
    },
    trustProxy: 1, // trust exactly one proxy hop (Nginx) — see docs/ARCHITECTURE.md §9
    bodyLimit: 1024 * 256,
  });
  const logger = app.log;

  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(formbody);

  // Security headers — see docs/SECURITY.md §1. Deliberately not maximally locked down in a
  // way that would itself be a fingerprinting tell, but never weakened into a real hole.
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'");
    reply.removeHeader("X-Powered-By");
    return payload;
  });

  const queue = new IngestionQueue(logger);
  registerIngestion(app, queue);

  registerPageRoutes(app);
  registerApiRoutes(app);
  registerAdminRoutes(app);
  registerMiscRoutes(app);
  registerNotFoundHandler(app);

  app.get("/internal/metrics", async (request, reply) => {
    request.hp.endpoint = "internal.metrics";
    request.hp.applicationComponent = "internal";
    reply.send(snapshotMetrics(queue.depth, config.queueCapacity));
  });

  await refreshCanaries();
  startCanaryRefresh(logger);
  queue.start();
  startCorrelationWorker(queue, logger);
  startHealthMonitor(queue, logger);

  await app.listen({ port: config.port, host: config.host });
  logger.info({ msg: "honeypot app listening", port: config.port });

  process.on("SIGTERM", async () => {
    queue.stop();
    await queue.flush();
    await app.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("fatal startup error", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
