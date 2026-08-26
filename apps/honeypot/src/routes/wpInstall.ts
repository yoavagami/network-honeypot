import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "../db.js";
import { config } from "../config.js";
import { hashPassword } from "../auth.js";
import { wpInstallStep1Page, wpInstallAlreadyPage, wpInstallSuccessPage } from "../render/wpInstall.js";
import { loginView, loginSubmit, type SyntheticUserData } from "./pages.js";

/**
 * Fake WordPress install-takeover flow — see docs/VULNERABILITY.md. Real WordPress permanently
 * locks install.php once a site is genuinely set up ("Already Installed"); this mirrors that
 * exactly, checked against the database (not in-memory) so the state survives restarts the same
 * way it would on a real WP site. Global, not per-actor: only the first actor to complete step 2
 * ever gets a working account — matching genuine WP behavior, and naturally capping this at
 * exactly one synthetic account regardless of how many people probe it.
 */
async function isAlreadyInstalled(): Promise<boolean> {
  const rows = await db.select().from(schema.syntheticObjects).where(eq(schema.syntheticObjects.objectType, "user"));
  return rows.some((r) => (r.data as SyntheticUserData).wpInstallBait === true);
}

export function registerWpInstallRoutes(app: FastifyInstance) {
  if (!config.wpInstallBaitEnabled) return; // unregistered entirely, same pattern as the other bait features

  // Real WordPress's login URL — only exists while this bait is active, same "invisible when
  // off" discipline as every other toggle in this app. Otherwise identical to /login.
  app.get("/wp-login.php", loginView);
  app.post("/wp-login.php", loginSubmit);

  app.get("/wp-admin/install.php", async (request, reply) => {
    request.hp.endpoint = "wp-install.view";
    request.hp.applicationComponent = "wp-install";
    request.hp.routeMatched = true;
    request.hp.extraEventTypes.push("WP_INSTALL_VIEWED");
    request.hp.extraRiskFlags.push("wpInstallViewed");

    const already = await isAlreadyInstalled();
    reply.type("text/html").send(already ? wpInstallAlreadyPage() : wpInstallStep1Page());
  });

  app.post("/wp-admin/install.php", async (request, reply) => {
    request.hp.endpoint = "wp-install.submit";
    request.hp.applicationComponent = "wp-install";
    request.hp.routeMatched = true;

    const already = await isAlreadyInstalled();
    if (already) {
      reply.type("text/html").send(wpInstallAlreadyPage());
      return;
    }

    const body = (request.body ?? {}) as Record<string, string>;
    const username = String(body.user_name ?? "").trim().slice(0, 60);
    const password = String(body.admin_password ?? "").slice(0, 256);
    const email = String(body.admin_email ?? "").trim().slice(0, 256);
    const siteTitle = String(body.weblog_title ?? "").trim().slice(0, 120);
    request.hp.canaryHaystacks.push(username, email);

    if (!username) {
      // Real WP re-shows the form with an error rather than accepting an empty username.
      reply.type("text/html").send(wpInstallStep1Page());
      return;
    }

    request.hp.extraEventTypes.push("WP_INSTALL_SUBMITTED");
    request.hp.extraRiskFlags.push("wpInstallSubmitted");
    request.hp.extraEventMetadata.submittedUsername = username;
    request.hp.extraEventMetadata.submittedEmail = email || null;
    request.hp.extraEventMetadata.submittedSiteTitle = siteTitle || null;

    const data: SyntheticUserData = {
      username,
      email: email || `${username}@example.invalid`,
      name: username,
      passwordHash: await hashPassword(password || randomUUID()),
      apiKeyPreview: `hp_sk_${randomUUID().slice(0, 8)}...`,
      wpInstallBait: true,
    };
    await db.insert(schema.syntheticObjects).values({
      objectId: randomUUID(),
      objectType: "user",
      publicRef: `wp-${randomUUID().slice(0, 8)}`,
      data,
      createdAt: new Date(),
    });

    reply.type("text/html").send(wpInstallSuccessPage({ username }));
  });
}
