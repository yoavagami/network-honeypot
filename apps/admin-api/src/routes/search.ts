import type { FastifyInstance } from "fastify";
import { desc } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "../db.js";
import { config } from "../config.js";
import { parseSearch } from "../search.js";
import { audit } from "../audit.js";

export function registerSearchRoutes(app: FastifyInstance) {
  app.get("/api/search", async (request, reply) => {
    const q = String((request.query as { q?: string }).q ?? "");
    const condition = parseSearch(q, config.ipHashSecret);
    const rows = await db
      .select()
      .from(schema.requests)
      .where(condition)
      .orderBy(desc(schema.requests.createdAt))
      .limit(100);

    await audit(request.adminSession!.adminUserId, "search", null, null, { query: q, resultCount: rows.length });
    reply.send({ data: rows, query: q });
  });
}
