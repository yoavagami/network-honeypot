import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "./db.js";
import { config } from "./config.js";

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export interface AdminSession {
  adminSessionId: string;
  adminUserId: string;
  csrfToken: string;
  username: string;
}

export async function createSession(adminUserId: string, ipHash: string | null): Promise<AdminSession> {
  const adminSessionId = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(32).toString("hex");
  const now = new Date();
  await db.insert(schema.adminSessions).values({
    adminSessionId,
    adminUserId,
    csrfToken,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + config.sessionAbsoluteTimeoutMs),
    ipHash,
  });
  const [user] = await db.select({ username: schema.adminUsers.username }).from(schema.adminUsers).where(eq(schema.adminUsers.adminUserId, adminUserId)).limit(1);
  return { adminSessionId, adminUserId, csrfToken, username: user?.username ?? "unknown" };
}

export async function loadSession(adminSessionId: string): Promise<AdminSession | null> {
  const [row] = await db
    .select({
      adminSessionId: schema.adminSessions.adminSessionId,
      adminUserId: schema.adminSessions.adminUserId,
      csrfToken: schema.adminSessions.csrfToken,
      lastSeenAt: schema.adminSessions.lastSeenAt,
      expiresAt: schema.adminSessions.expiresAt,
      username: schema.adminUsers.username,
      disabled: schema.adminUsers.disabled,
    })
    .from(schema.adminSessions)
    .innerJoin(schema.adminUsers, eq(schema.adminUsers.adminUserId, schema.adminSessions.adminUserId))
    .where(eq(schema.adminSessions.adminSessionId, adminSessionId))
    .limit(1);

  if (!row || row.disabled) return null;
  const now = Date.now();
  if (row.expiresAt.getTime() < now) return null;
  if (row.lastSeenAt.getTime() + config.sessionIdleTimeoutMs < now) return null;

  await db.update(schema.adminSessions).set({ lastSeenAt: new Date() }).where(eq(schema.adminSessions.adminSessionId, adminSessionId));

  return { adminSessionId: row.adminSessionId, adminUserId: row.adminUserId, csrfToken: row.csrfToken, username: row.username };
}

export async function destroySession(adminSessionId: string) {
  await db.delete(schema.adminSessions).where(eq(schema.adminSessions.adminSessionId, adminSessionId));
}
