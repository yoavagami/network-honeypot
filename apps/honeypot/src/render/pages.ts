import { layout, esc } from "./layout.js";

export function homePage(): string {
  return layout({
    title: "Meridian — Project & Invoice Management",
    activeNav: "/",
    body: `
      <section class="hero">
        <h1>Run your team's projects and invoicing from one place</h1>
        <p>Meridian connects project tracking, client documents, and billing so nothing falls through the cracks.</p>
        <a class="button" href="/register">Start free trial</a>
        <a class="button secondary" href="/login">Sign in</a>
      </section>
      <section class="features">
        <div class="card"><h3>Projects</h3><p>Organize work by client and milestone.</p></div>
        <div class="card"><h3>Invoicing</h3><p>Send and track invoices in one click.</p></div>
        <div class="card"><h3>API access</h3><p>Automate Meridian with our <a href="/docs">REST API</a>.</p></div>
      </section>`,
  });
}

export function loginPage(opts: { error?: string } = {}): string {
  return layout({
    title: "Sign in",
    activeNav: "/login",
    body: `
      <section class="form-page">
        <h1>Sign in to Meridian</h1>
        ${opts.error ? `<p class="alert">${esc(opts.error)}</p>` : ""}
        <form method="post" action="/login">
          <label>Email or username<input type="text" name="username" autocomplete="username" required /></label>
          <label>Password<input type="password" name="password" autocomplete="current-password" required /></label>
          <button type="submit">Sign in</button>
        </form>
        <p><a href="/reset-password">Forgot password?</a> &middot; <a href="/register">Create an account</a></p>
      </section>`,
  });
}

export function registerPage(opts: { error?: string } = {}): string {
  return layout({
    title: "Create account",
    activeNav: "/register",
    body: `
      <section class="form-page">
        <h1>Create your Meridian account</h1>
        ${opts.error ? `<p class="alert">${esc(opts.error)}</p>` : ""}
        <form method="post" action="/register">
          <label>Full name<input type="text" name="name" required /></label>
          <label>Email<input type="email" name="email" required /></label>
          <label>Password<input type="password" name="password" required minlength="8" /></label>
          <button type="submit">Create account</button>
        </form>
      </section>`,
  });
}

export function resetPasswordPage(opts: { submitted?: boolean } = {}): string {
  return layout({
    title: "Reset password",
    activeNav: "/reset-password",
    body: `
      <section class="form-page">
        <h1>Reset your password</h1>
        ${
          opts.submitted
            ? `<p class="notice">If an account matches that email, we've sent password reset instructions.</p>`
            : `<form method="post" action="/reset-password">
                <label>Email<input type="email" name="email" required /></label>
                <button type="submit">Send reset link</button>
              </form>`
        }
      </section>`,
  });
}

export function profilePage(user: { name: string; email: string; publicRef: string; apiKeyPreview: string }): string {
  return layout({
    title: "Your profile",
    activeNav: "/profile",
    body: `
      <section class="form-page">
        <h1>Account settings</h1>
        <dl class="profile">
          <dt>Name</dt><dd>${esc(user.name)}</dd>
          <dt>Email</dt><dd>${esc(user.email)}</dd>
          <dt>User ID</dt><dd>${esc(user.publicRef)}</dd>
          <dt>API key</dt><dd><code>${esc(user.apiKeyPreview)}</code> <a href="/profile/api-key">Regenerate</a></dd>
        </dl>
      </section>`,
  });
}

export function searchPage(opts: { query?: string; results: Array<{ title: string; type: string; href: string }> }): string {
  const results = opts.results
    .map((r) => `<li><a href="${r.href}">${esc(r.title)}</a> <span class="badge">${esc(r.type)}</span></li>`)
    .join("\n");
  return layout({
    title: "Search",
    activeNav: "/search",
    body: `
      <section class="form-page">
        <h1>Search Meridian</h1>
        <form method="get" action="/search">
          <input type="search" name="q" value="${esc(opts.query ?? "")}" placeholder="Search projects, invoices, people…" />
          <button type="submit">Search</button>
        </form>
        ${opts.query ? `<ul class="results">${results || "<li>No results.</li>"}</ul>` : ""}
      </section>`,
  });
}

export function docsPage(): string {
  return layout({
    title: "API Documentation",
    activeNav: "/docs",
    body: `
      <section class="docs">
        <h1>Meridian API</h1>
        <p>Base URL: <code>https://api.meridian.example/v1</code></p>
        <ul>
          <li><code>GET /api/v1/users</code> — list users in your organization</li>
          <li><code>GET /api/v1/users/:id</code> — get a user by ID</li>
          <li><code>GET /api/v1/objects</code> — list documents/invoices</li>
          <li><code>GET /api/v1/objects/:id</code> — get an object by ID</li>
          <li><code>GET /api/v1/search?q=</code> — full text search</li>
          <li><code>GET /api/v1/config</code> — client-safe runtime configuration</li>
          <li><code>GET /api/v1/health</code> — service health</li>
        </ul>
        <p>Authenticate with a bearer token: <code>Authorization: Bearer &lt;api_key&gt;</code>. See your <a href="/profile">profile</a> for your key.</p>
        <p class="muted"><!-- changelog: migrated internal billing sync off int-billing-01.meridian.internal on 2026-03-02 --></p>
      </section>`,
  });
}

export function adminLoginPage(opts: { error?: string } = {}): string {
  return layout({
    title: "Admin sign in",
    body: `
      <section class="form-page">
        <h1>Meridian Admin</h1>
        ${opts.error ? `<p class="alert">${esc(opts.error)}</p>` : ""}
        <form method="post" action="/admin/login">
          <label>Username<input type="text" name="username" required /></label>
          <label>Password<input type="password" name="password" required /></label>
          <button type="submit">Sign in</button>
        </form>
      </section>`,
  });
}

export function adminDashboardPage(): string {
  return layout({
    title: "Admin",
    body: `
      <section class="form-page">
        <h1>Admin overview</h1>
        <p>You do not have sufficient privileges to view this area.</p>
      </section>`,
  });
}

export function notFoundPage(): string {
  return layout({
    title: "Page not found",
    body: `<section class="error-page"><h1>404</h1><p>The page you're looking for doesn't exist or has moved.</p></section>`,
  });
}

export function serverErrorPage(statusCode = 500): string {
  return layout({
    title: "Something went wrong",
    body: `<section class="error-page"><h1>${statusCode}</h1><p>An unexpected error occurred. Our team has been notified.</p></section>`,
  });
}

export function privacyPage(): string {
  return layout({
    title: "Privacy",
    body: `
      <section class="docs">
        <h1>Privacy</h1>
        <p>Meridian records standard request telemetry (IP address, user agent, requested paths) for security and abuse
        prevention. Raw IP addresses are retained for a limited period; aggregated security telemetry may be retained
        longer. We do not sell personal data. Contact privacy@meridian.example with questions.</p>
      </section>`,
  });
}
