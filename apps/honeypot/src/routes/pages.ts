import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "../db.js";
import { verifyPassword } from "../auth.js";
import { homePage, loginPage, registerPage, resetPasswordPage, profilePage, searchPage, docsPage, privacyPage } from "../render/pages.js";
import { passwordShape } from "@honeypot/logging";

export interface SyntheticUserData {
  username: string;
  email: string;
  name: string;
  passwordHash: string;
  apiKeyPreview: string;
  /** Set only on accounts created by the WP install-takeover bait (routes/wpInstall.ts) — lets
   * a successful login here fire WP_TAKEOVER_CONFIRMED instead of a plain LOGIN_SUCCESS. */
  wpInstallBait?: boolean;
}

async function findSyntheticUser(usernameOrEmail: string) {
  const rows = await db
    .select()
    .from(schema.syntheticObjects)
    .where(eq(schema.syntheticObjects.objectType, "user"));
  return rows.find((r) => {
    const data = r.data as SyntheticUserData;
    return data.username === usernameOrEmail || data.email === usernameOrEmail;
  });
}

export const loginView: RouteHandlerMethod = async (request, reply) => {
  request.hp.endpoint = "auth.login.view";
  request.hp.applicationComponent = "auth";
  request.hp.extraEventTypes.push("AUTH_PAGE_VIEW");
  reply.type("text/html").send(loginPage());
};

// Also registered as /wp-login.php (routes/wpInstall.ts, gated behind WP_INSTALL_BAIT_ENABLED)
// — same logic, real WordPress's login URL, needed so the WP install-takeover bait's "Log In"
// link goes somewhere that actually completes the loop rather than 404ing. See docs/VULNERABILITY.md.
export const loginSubmit: RouteHandlerMethod = async (request, reply) => {
  request.hp.endpoint = "auth.login.submit";
  request.hp.applicationComponent = "auth";
  const body = (request.body ?? {}) as { username?: string; password?: string };
  const username = String(body.username ?? "").slice(0, 256);
  const password = String(body.password ?? "").slice(0, 256);
  request.hp.canaryHaystacks.push(password);

  const user = await findSyntheticUser(username);
  const userData = user?.data as SyntheticUserData | undefined;
  const passwordOk = userData ? await verifyPassword(userData.passwordHash, password) : false;

  if (user && userData && passwordOk) {
    request.hp.extraEventTypes.push("LOGIN_ATTEMPT", "LOGIN_SUCCESS");
    if (userData.wpInstallBait) {
      request.hp.extraEventTypes.push("WP_TAKEOVER_CONFIRMED");
      request.hp.extraRiskFlags.push("wpTakeoverConfirmed");
    }
    await db.update(schema.sessions).set({ authenticatedAs: username }).where(eq(schema.sessions.sessionId, request.hp.sessionId));
    reply.redirect("/profile");
    return;
  }

  request.hp.extraEventTypes.push("LOGIN_ATTEMPT", "LOGIN_FAILURE");
  request.hp.authEvent = { type: "LOGIN_FAILURE", username };
  void passwordShape(password); // shape computed for parity with redaction contract; not persisted here
  reply.type("text/html").status(401).send(loginPage({ error: "Invalid email/username or password." }));
};

export function registerPageRoutes(app: FastifyInstance) {
  app.get("/", async (request, reply) => {
    request.hp.endpoint = "site.home";
    request.hp.applicationComponent = "site";
    reply.type("text/html").send(homePage());
  });

  app.get("/privacy", async (request, reply) => {
    request.hp.endpoint = "site.privacy";
    request.hp.applicationComponent = "site";
    reply.type("text/html").send(privacyPage());
  });

  app.get("/docs", async (request, reply) => {
    request.hp.endpoint = "site.docs";
    request.hp.applicationComponent = "docs";
    request.hp.extraEventTypes.push("API_DOCUMENTATION_ACCESS");
    reply.type("text/html").send(docsPage());
  });

  app.get("/login", loginView);
  app.post("/login", loginSubmit);

  app.get("/register", async (request, reply) => {
    request.hp.endpoint = "auth.register.view";
    request.hp.applicationComponent = "auth";
    reply.type("text/html").send(registerPage());
  });

  app.post("/register", async (request, reply) => {
    request.hp.endpoint = "auth.register.submit";
    request.hp.applicationComponent = "auth";
    request.hp.extraEventTypes.push("REGISTRATION_ATTEMPT");
    const body = (request.body ?? {}) as { name?: string; email?: string; password?: string };
    const email = String(body.email ?? "").slice(0, 256);

    const existing = await findSyntheticUser(email);
    if (existing) {
      reply.type("text/html").status(409).send(registerPage({ error: "An account with that email already exists." }));
      return;
    }

    // Realistic-looking success without ever creating persistent real capability — the
    // "account" isn't actually created; this models a plausible flow for observation purposes.
    reply.type("text/html").send(registerPage({ error: undefined }));
  });

  app.get("/reset-password", async (request, reply) => {
    request.hp.endpoint = "auth.reset.view";
    request.hp.applicationComponent = "auth";
    reply.type("text/html").send(resetPasswordPage());
  });

  app.post("/reset-password", async (request, reply) => {
    request.hp.endpoint = "auth.reset.submit";
    request.hp.applicationComponent = "auth";
    request.hp.extraEventTypes.push("PASSWORD_RESET_ATTEMPT");
    request.hp.authEvent = { type: "PASSWORD_RESET_ATTEMPT" };
    reply.type("text/html").send(resetPasswordPage({ submitted: true }));
  });

  app.get("/profile", async (request, reply) => {
    request.hp.endpoint = "site.profile";
    request.hp.applicationComponent = "profile";
    const [session] = await db.select({ authenticatedAs: schema.sessions.authenticatedAs }).from(schema.sessions).where(eq(schema.sessions.sessionId, request.hp.sessionId)).limit(1);
    if (!session?.authenticatedAs) {
      reply.redirect("/login");
      return;
    }
    const user = await findSyntheticUser(session.authenticatedAs);
    if (!user) {
      reply.redirect("/login");
      return;
    }
    const data = user.data as SyntheticUserData;
    reply.type("text/html").send(profilePage({ name: data.name, email: data.email, publicRef: user.publicRef, apiKeyPreview: data.apiKeyPreview }));
  });

  app.get("/search", async (request, reply) => {
    request.hp.endpoint = "site.search";
    request.hp.applicationComponent = "search";
    const query = String((request.query as Record<string, string>).q ?? "");
    request.hp.canaryHaystacks.push(query);

    let results: Array<{ title: string; type: string; href: string }> = [];
    if (query) {
      const objects = await db.select().from(schema.syntheticObjects).where(eq(schema.syntheticObjects.objectType, "document"));
      results = objects
        .filter((o) => JSON.stringify(o.data).toLowerCase().includes(query.toLowerCase()))
        .slice(0, 10)
        .map((o) => ({ title: (o.data as { title?: string }).title ?? o.publicRef, type: "document", href: `/api/v1/objects/${o.publicRef}` }));
    }
    reply.type("text/html").send(searchPage({ query, results }));
  });
}
