import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { config } from "./config.js";
import "./context.js";
import { registerAuthMiddleware } from "./middleware.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerActorRoutes } from "./routes/actors.js";
import { registerDetectionRoutes } from "./routes/detections.js";
import { registerCanaryRoutes } from "./routes/canaries.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerStreamRoute } from "./routes/stream.js";

async function main() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info", base: { service: "admin-api" } },
    trustProxy: 1,
  });

  await app.register(cors, { origin: config.adminWebOrigin, credentials: true });
  await app.register(cookie);

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Content-Security-Policy", "default-src 'none'");
    reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    return payload;
  });

  registerAuthMiddleware(app);

  registerAuthRoutes(app);
  registerEventRoutes(app);
  registerActorRoutes(app);
  registerDetectionRoutes(app);
  registerCanaryRoutes(app);
  registerAnalyticsRoutes(app);
  registerSearchRoutes(app);
  registerSystemRoutes(app);
  registerStreamRoute(app);

  await app.listen({ port: config.port, host: config.host });
  app.log.info({ msg: "admin-api listening", port: config.port });
}

main().catch((err) => {
  console.error("fatal startup error", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
