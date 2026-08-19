import "fastify";
import type { AdminSession } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    adminSession: AdminSession | null;
  }
}
