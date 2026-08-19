/**
 * Attacker traffic simulator — exercises recon, ID/parameter enumeration, auth probing,
 * fuzzing, scanner-shaped bursts, canary discovery+reuse, and a benign human-like session,
 * against a running honeypot instance. See docs/ROADMAP.md Phase 1 and docs/DETECTION.md.
 *
 * Usage: HONEYPOT_URL=http://localhost:8080 pnpm simulate
 */

const BASE = process.env.HONEYPOT_URL ?? "http://localhost:8080";

class Persona {
  private cookies = new Map<string, string>();
  constructor(
    public name: string,
    private userAgent: string
  ) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private captureCookies(res: Response) {
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) return;
    // Node's fetch merges multiple Set-Cookie headers with a comma in some environments; handle
    // the common single-value case robustly enough for a local simulator.
    for (const part of setCookie.split(/,(?=[^;]+?=)/)) {
      const [pair] = part.split(";");
      const [k, v] = pair!.split("=");
      if (k && v) this.cookies.set(k.trim(), v.trim());
    }
  }

  async request(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; label?: string } = {}) {
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Cookie: this.cookieHeader(),
      ...opts.headers,
    };
    if (opts.body) headers["Content-Type"] = headers["Content-Type"] ?? "application/json";

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: opts.body ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined,
    });
    this.captureCookies(res);
    console.log(`[${this.name}] ${method} ${path} -> ${res.status}${opts.label ? ` (${opts.label})` : ""}`);
    return res;
  }

  async get(path: string, label?: string) {
    return this.request("GET", path, { label });
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function humanVisitor() {
  const p = new Persona("human", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36");
  await p.get("/", "homepage");
  await sleep(300);
  await p.get("/docs", "read docs");
  await sleep(200);
  await p.get("/search?q=invoice", "search");
  await sleep(150);
  await p.get("/login", "view login");
}

async function searchCrawler() {
  const p = new Persona("googlebot", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
  await p.get("/robots.txt", "crawler baseline");
  await sleep(50);
  await p.get("/sitemap.xml", "sitemap discovery");
  await sleep(50);
  await p.get("/", "index homepage");
}

async function aiAgent() {
  const p = new Persona("ai-agent", "Mozilla/5.0 (compatible; ClaudeBot/1.0; +https://www.anthropic.com/claude-bot)");
  await p.get("/robots.txt", "check robots first");
  await sleep(80);
  await p.get("/docs", "discover API docs");
  await sleep(80);
  await p.get("/api/v1", "explore API root");
  await sleep(80);
  await p.get("/api/v1/health", "check health");
}

async function reconAndEnumeration() {
  const p = new Persona("recon", "curl/8.4.0");
  for (const path of ["/.env", "/.git/config", "/wp-admin/setup.php", "/backup.zip", "/server-status"]) {
    await p.get(path, "recon signature");
    await sleep(60);
  }
  await p.get("/robots.txt");
  await sleep(60);
  await p.get("/api/v1/users", "discover users endpoint");
  await sleep(60);
  for (let id = 1000; id <= 1007; id++) {
    await p.get(`/api/v1/users/${id}`, "sequential ID enumeration");
    await sleep(40);
  }
  return p;
}

async function authProbing() {
  const p = new Persona("credstuff", "python-requests/2.31.0");
  const usernames = ["admin", "alice", "root", "test", "administrator"];
  for (const username of usernames) {
    await p.request("POST", "/login", { body: { username, password: "Summer2024!" }, label: `try ${username}` });
    await sleep(80);
  }
  await p.request("POST", "/reset-password", { body: { email: "admin@meridian.example" } });
  await sleep(80);
  await p.request("POST", "/reset-password", { body: { email: "alice@meridian.example" } });
  await sleep(80);
  await p.request("POST", "/reset-password", { body: { email: "root@meridian.example" } });
  return p;
}

async function fuzzer() {
  const p = new Persona("fuzzer", "Nuclei/3.2");
  const paths = [
    "/actuator/env",
    "/console",
    "/debug",
    "/.aws/credentials",
    "/config.php.bak",
    "/docker-compose.yml",
    "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php",
    "/.dockerenv",
    "/wp-json/wp/v2/users",
    "/xmlrpc.php",
    "/phpinfo.php",
    "/server-info",
    "/.svn/entries",
    "/.idea/workspace.xml",
    "/graphql",
    "/v2/api-docs",
    "/swagger-ui.html",
    "/actuator/health",
    "/metrics",
    "/.well-known/openid-configuration",
    "/api/internal/debug",
    "/api/v2/users",
    "/api/v1/../../../etc/passwd",
    "/index.php~",
    "/app.js.map",
  ];
  for (const path of paths) {
    await p.get(path, "fuzz");
    await sleep(15);
  }
  return p;
}

async function scannerBurst() {
  // Staggered (not fully simultaneous) so the burst clears Nginx's rate-limit zone and reaches
  // the app layer — see docs/ROADMAP.md "Phase 1 self-review" for what happens (and what's
  // currently invisible to the dashboard) when a burst exceeds Nginx's limit_req burst capacity.
  const p = new Persona("scanner", "python-requests/2.31.0");
  for (let i = 0; i < 18; i++) {
    await p.get(`/probe/${i}`);
    await sleep(40);
  }
  return p;
}

async function canaryHunter() {
  const p = new Persona("canary-hunter", "python-requests/2.31.0");
  const res = await p.get("/api/v1/config", "discover config");
  const body = (await res.json()) as { publicApiKey?: string };
  const key = body.publicApiKey;
  if (key) {
    await p.get("/api/v1/admin/config", `attempt reuse of discovered key metadata`);
    await p.request("GET", "/api/v1/users", { headers: { Authorization: `Bearer ${key}` }, label: "reuse canary key as bearer token" });
  }
  return p;
}

async function main() {
  console.log(`Simulating attacker + benign traffic against ${BASE}\n`);

  await humanVisitor();
  await searchCrawler();
  await aiAgent();
  await reconAndEnumeration();
  await authProbing();
  await fuzzer();
  await scannerBurst();
  await canaryHunter();

  console.log("\nDone. Give the correlation worker a few seconds, then check the dashboard.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
