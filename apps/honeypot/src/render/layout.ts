function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface LayoutOptions {
  title: string;
  activeNav?: string;
  body: string;
}

const NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/search", label: "Search" },
  { href: "/docs", label: "Docs" },
  { href: "/login", label: "Sign in" },
];

/**
 * Plain server-rendered HTML shell — deliberately unremarkable, the way a mid-size SaaS
 * marketing/app site looks. No client framework hydration noise to fingerprint.
 */
export function layout({ title, activeNav, body }: LayoutOptions): string {
  const nav = NAV_ITEMS.map(
    (item) => `<a href="${item.href}" class="nav-link${item.href === activeNav ? " active" : ""}">${esc(item.label)}</a>`
  ).join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} · Meridian</title>
  <link rel="stylesheet" href="/assets/app.css" />
</head>
<body>
  <header class="site-header">
    <a href="/" class="brand">Meridian</a>
    <nav>
      ${nav}
    </nav>
  </header>
  <main class="container">
    ${body}
  </main>
  <footer class="site-footer">
    <p>&copy; ${new Date().getFullYear()} Meridian Labs, Inc. &middot; <a href="/privacy">Privacy</a> &middot; <a href="/docs">API Docs</a> &middot; <a href="/status">Status</a></p>
  </footer>
  <script src="/assets/app.js" defer></script>
</body>
</html>`;
}

export { esc };
