import type { FastifyInstance } from "fastify";
import { adminLoginPage, adminDashboardPage } from "../render/pages.js";
import { getCanaryValueForLocation } from "../ingestion/canaries.js";

/**
 * The fake admin area. Nothing here grants real privilege — it exists purely to attract and
 * observe privilege-probing behavior. See docs/ATTACK_SURFACE.md "Admin area"/"Admin login".
 */
export function registerAdminRoutes(app: FastifyInstance) {
  app.get("/admin", async (request, reply) => {
    request.hp.endpoint = "admin.root";
    request.hp.applicationComponent = "admin_decoy";
    request.hp.isAdminArea = true;
    reply.type("text/html").send(adminLoginPage());
  });

  app.get("/admin/dashboard", async (request, reply) => {
    request.hp.endpoint = "admin.dashboard";
    request.hp.applicationComponent = "admin_decoy";
    request.hp.isAdminArea = true;
    reply.type("text/html").send(adminDashboardPage());
  });

  app.post("/admin/login", async (request, reply) => {
    request.hp.endpoint = "admin.login.submit";
    request.hp.applicationComponent = "admin_decoy";
    request.hp.isAdminArea = true;
    request.hp.extraEventTypes.push("ADMIN_LOGIN_ATTEMPT");
    const body = (request.body ?? {}) as { username?: string; password?: string };
    request.hp.authEvent = { type: "LOGIN_FAILURE", username: String(body.username ?? "").slice(0, 256) };
    // Always fails — there is no real admin credential path on the public surface at all.
    reply.status(401).type("text/html").send(adminLoginPage({ error: "Invalid credentials." }));
  });

  app.get("/api/v1/admin/config", async (request, reply) => {
    request.hp.endpoint = "admin.api.config";
    request.hp.applicationComponent = "admin_decoy";
    request.hp.isAdminArea = true;
    const canaryToken = await getCanaryValueForLocation("GET /api/v1/admin/config");
    reply.status(403).send({ error: { code: "forbidden", message: "Admin scope required" }, hint: canaryToken ?? undefined });
  });
}
