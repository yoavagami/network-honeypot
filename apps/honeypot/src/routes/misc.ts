import type { FastifyInstance } from "fastify";

export function registerMiscRoutes(app: FastifyInstance) {
  app.get("/robots.txt", async (request, reply) => {
    request.hp.endpoint = "site.robots";
    request.hp.applicationComponent = "site";
    request.hp.extraEventTypes.push("ROBOTS_ACCESS");
    reply.type("text/plain").send("User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: /sitemap.xml\n");
  });

  app.get("/sitemap.xml", async (request, reply) => {
    request.hp.endpoint = "site.sitemap";
    request.hp.applicationComponent = "site";
    request.hp.extraEventTypes.push("SITEMAP_ACCESS");
    reply.type("application/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
        ["/", "/login", "/register", "/docs", "/search", "/customers"].map((p) => `<url><loc>https://meridian.example${p}</loc></url>`).join("") +
        `</urlset>`
    );
  });

  app.get("/.well-known/security.txt", async (request, reply) => {
    request.hp.endpoint = "site.security_txt";
    request.hp.applicationComponent = "site";
    reply.type("text/plain").send("Contact: mailto:security@meridian.example\nExpires: 2027-01-01T00:00:00.000Z\n");
  });

  app.get("/health", async (request, reply) => {
    request.hp.endpoint = "site.health";
    request.hp.applicationComponent = "site";
    request.hp.extraEventTypes.push("HEALTH_ENDPOINT_ACCESS");
    reply.send({ status: "ok" });
  });

  app.get("/status", async (request, reply) => {
    request.hp.endpoint = "site.status";
    request.hp.applicationComponent = "site";
    request.hp.extraEventTypes.push("HEALTH_ENDPOINT_ACCESS");
    reply.type("text/html").send("<html><body><h1>All systems operational</h1></body></html>");
  });

  app.get("/assets/app.css", async (request, reply) => {
    request.hp.endpoint = "site.asset";
    request.hp.applicationComponent = "static";
    reply.type("text/css").send(APP_CSS);
  });

  app.get("/assets/app.js", async (request, reply) => {
    request.hp.endpoint = "site.asset";
    request.hp.applicationComponent = "static";
    reply.type("application/javascript").send("// Meridian client bundle (minimal, no telemetry SDK)\n");
  });
}

const APP_CSS = `
:root { --fg:#1a1a2e; --muted:#6b7280; --accent:#4f46e5; --border:#e5e7eb; }
* { box-sizing: border-box; }
body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--fg); line-height:1.5; }
.site-header { display:flex; justify-content:space-between; align-items:center; padding:1rem 2rem; border-bottom:1px solid var(--border); }
.brand { font-weight:700; text-decoration:none; color:var(--fg); font-size:1.25rem; }
nav { display:flex; gap:1.25rem; }
.nav-link { text-decoration:none; color:var(--muted); }
.nav-link.active { color:var(--accent); font-weight:600; }
.container { max-width:960px; margin:0 auto; padding:2rem; }
.hero { text-align:center; padding:3rem 1rem; }
.hero h1 { font-size:2rem; }
.button { display:inline-block; padding:.6rem 1.2rem; border-radius:6px; background:var(--accent); color:#fff; text-decoration:none; margin:.5rem; }
.button.secondary { background:transparent; color:var(--accent); border:1px solid var(--accent); }
.features { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:1rem; margin-top:2rem; }
.card { border:1px solid var(--border); border-radius:8px; padding:1.25rem; }
.form-page { max-width:420px; margin:0 auto; }
.form-page form { display:flex; flex-direction:column; gap:1rem; margin-top:1rem; }
.form-page label { display:flex; flex-direction:column; gap:.35rem; font-size:.9rem; color:var(--muted); }
.form-page input { padding:.5rem; border:1px solid var(--border); border-radius:6px; font-size:1rem; }
.form-page button { padding:.65rem; border:none; border-radius:6px; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }
.alert { background:#fef2f2; color:#991b1b; padding:.75rem; border-radius:6px; }
.notice { background:#f0fdf4; color:#166534; padding:.75rem; border-radius:6px; }
.profile dt { color:var(--muted); font-size:.85rem; margin-top:.75rem; }
.profile dd { margin:0; }
.results { list-style:none; padding:0; }
.results li { padding:.5rem 0; border-bottom:1px solid var(--border); }
.badge { font-size:.75rem; color:var(--muted); }
.docs code { background:#f3f4f6; padding:.15rem .4rem; border-radius:4px; }
.docs ul { line-height:2; }
.error-page { text-align:center; padding:4rem 1rem; }
.site-footer { text-align:center; color:var(--muted); font-size:.85rem; padding:2rem; }
.muted { color: var(--border); font-size: 0.01px; }
`;
