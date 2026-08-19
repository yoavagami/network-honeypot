import { schema } from "@honeypot/db";
import { db } from "./db.js";

/** Every authenticated admin action is audit-logged — see docs/SECURITY.md §2. */
export async function audit(adminUserId: string | null, action: string, target: string | null, ipHash: string | null, metadata: Record<string, unknown> = {}) {
  await db.insert(schema.adminAuditLog).values({
    adminUserId,
    createdAt: new Date(),
    action,
    target,
    ipHash,
    metadata,
  });
}
