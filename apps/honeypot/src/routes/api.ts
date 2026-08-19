import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "../db.js";
import { getCanaryValueForLocation } from "../ingestion/canaries.js";

interface SyntheticUserData {
  username: string;
  email: string;
  name: string;
  publicApiFields: Record<string, unknown>;
}

function publicUser(publicRef: string, data: SyntheticUserData) {
  return { id: publicRef, username: data.username, email: data.email, name: data.name, ...data.publicApiFields };
}

export function registerApiRoutes(app: FastifyInstance) {
  app.get("/api/v1", async (request, reply) => {
    request.hp.endpoint = "api.root";
    request.hp.applicationComponent = "api";
    request.hp.extraEventTypes.push("API_REQUEST");
    reply.send({
      name: "Meridian API",
      version: "1.4.2",
      documentation: "https://api.meridian.example/docs",
      endpoints: ["/api/v1/users", "/api/v1/objects", "/api/v1/search", "/api/v1/config", "/api/v1/health"],
    });
  });

  app.get("/api/v1/health", async (request, reply) => {
    request.hp.endpoint = "api.health";
    request.hp.applicationComponent = "api";
    request.hp.extraEventTypes.push("HEALTH_ENDPOINT_ACCESS");
    reply.send({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
  });

  app.get("/api/v1/config", async (request, reply) => {
    request.hp.endpoint = "api.config";
    request.hp.applicationComponent = "api";
    request.hp.extraEventTypes.push("API_REQUEST");
    const canaryKey = await getCanaryValueForLocation("GET /api/v1/config");
    reply.send({
      environment: "production",
      region: "us-east-1",
      features: { billing: true, sso: false, apiV2: false },
      // Client-safe config a real app might expose — including a scoped key, which here is a
      // synthetic canary that is never valid anywhere real. See docs/DATA_MODEL.md canary_objects.
      publicApiKey: canaryKey ?? "hp_pk_unset",
    });
  });

  app.get("/api/v1/users", async (request, reply) => {
    request.hp.endpoint = "api.users.list";
    request.hp.applicationComponent = "api";
    request.hp.extraEventTypes.push("API_REQUEST");
    const rows = await db.select().from(schema.syntheticObjects).where(eq(schema.syntheticObjects.objectType, "user"));
    reply.send({ data: rows.map((r) => publicUser(r.publicRef, r.data as SyntheticUserData)), total: rows.length });
  });

  app.get("/api/v1/users/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    request.hp.endpoint = "api.users.get";
    request.hp.applicationComponent = "api";
    request.hp.pathTemplate = "/api/v1/users/:id";
    request.hp.pathParams = { id };
    request.hp.extraEventTypes.push("API_REQUEST");
    // Sequential/bulk access to this route is flagged by the correlation worker's
    // detectIdEnumeration rule (docs/DETECTION.md §2), which reads pathTemplate/pathParams
    // recorded above rather than anything computed per-request here.

    const [row] = await db.select().from(schema.syntheticObjects).where(eq(schema.syntheticObjects.publicRef, id)).limit(1);
    if (!row || row.objectType !== "user") {
      reply.status(404).send({ error: { code: "not_found", message: "User not found" } });
      return;
    }
    reply.send(publicUser(row.publicRef, row.data as SyntheticUserData));
  });

  app.get("/api/v1/objects", async (request, reply) => {
    request.hp.endpoint = "api.objects.list";
    request.hp.applicationComponent = "api";
    request.hp.extraEventTypes.push("API_REQUEST");
    const rows = await db.select().from(schema.syntheticObjects).where(eq(schema.syntheticObjects.objectType, "document"));
    reply.send({ data: rows.map((r) => ({ id: r.publicRef, ...(r.data as object) })), total: rows.length });
  });

  app.get("/api/v1/objects/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    request.hp.endpoint = "api.objects.get";
    request.hp.applicationComponent = "api";
    request.hp.pathTemplate = "/api/v1/objects/:id";
    request.hp.pathParams = { id };
    request.hp.extraEventTypes.push("API_REQUEST");
    request.hp.canaryHaystacks.push(id);

    const [row] = await db.select().from(schema.syntheticObjects).where(eq(schema.syntheticObjects.publicRef, id)).limit(1);
    if (!row) {
      request.hp.extraEventTypes.push("FILE_ACCESS_ATTEMPT");
      reply.status(404).send({ error: { code: "not_found", message: "Object not found" } });
      return;
    }
    reply.send({ id: row.publicRef, ...(row.data as object) });
  });

  app.get("/api/v1/search", async (request, reply) => {
    request.hp.endpoint = "api.search";
    request.hp.applicationComponent = "api";
    request.hp.extraEventTypes.push("API_REQUEST");
    const q = String((request.query as Record<string, string>).q ?? "");
    request.hp.canaryHaystacks.push(q);
    if (!q) {
      reply.status(400).send({ error: { code: "invalid_parameter", message: "q is required" } });
      request.hp.paramValidationFailed = true;
      return;
    }
    const rows = await db.select().from(schema.syntheticObjects);
    const results = rows.filter((r) => JSON.stringify(r.data).toLowerCase().includes(q.toLowerCase())).slice(0, 20);
    reply.send({ data: results.map((r) => ({ id: r.publicRef, type: r.objectType })), total: results.length });
  });
}
