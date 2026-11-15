import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toHtml } from "./markdown.js";

/**
 * Builds the integration docs from one source (docs/integrate): the developer page, the agent
 * file, llms.txt, the changelog and a copy of the OpenAPI contract, into apps/merchant-api/generated.
 * Both documents share the same steps and the same snippet files, so they cannot disagree.
 * Placeholders ({{API_URL}}, …) are filled when merchant-api serves the files (routes/static.ts).
 *
 *   pnpm --filter @honeypot/app-merchant-api build:docs
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SRC = path.join(ROOT, "docs/integrate");
const OUT = path.join(ROOT, "apps/merchant-api/generated");
const read = (p: string) => readFileSync(path.join(SRC, p), "utf8").trim();
const LANG: Record<string, string> = { ".mjs": "js", ".js": "js", ".ts": "ts", ".tsx": "tsx", ".php": "php", ".html": "html" };

function includeSnippets(md: string): string {
  return md.replace(/\{\{snippet:([a-z0-9/_.-]+)\}\}/g, (_m, file: string) => {
    const body = readFileSync(path.join(SRC, "snippets", file), "utf8").trimEnd();
    return "```" + (LANG[path.extname(file)] ?? "") + "\n" + body + "\n```";
  });
}

const STACKS = [["nextjs", "Next.js"], ["express", "Express"], ["php", "PHP"], ["generic", "Anything else"]] as const;

export function buildDocs(): Record<string, string> {
  const steps = readdirSync(path.join(SRC, "steps")).filter((f) => f.endsWith(".md")).sort().map((f) => read(`steps/${f}`));
  const recipes = STACKS.map(([f]) => read(`recipes/${f}.md`));
  const shared = includeSnippets([...steps, "## Stack recipes", ...recipes, read("troubleshooting.md")].join("\n\n"));

  const agent = includeSnippets([read("agent/header.md"), shared, read("agent/footer.md")].join("\n\n")) + "\n";

  const intro = [
    "# Integrate uHoney",
    "Detect AI agents on your store and get a verdict when someone presses Pay. Three pieces: a tag on every page, one server call before the charge, and a webhook. About 30 minutes.",
    "**Using a coding agent?** Put your test keys in `.env` and tell it: `Integrate uHoney using {{AGENT_URL}}`. It follows the same steps as this page.",
  ].join("\n\n");
  const { html, headings } = toHtml(`${intro}\n\n${shared}`);
  const toc = headings.filter((h) => h.level === 2 || (h.level === 3 && STACKS.some(([, n]) => h.text.startsWith(n)))).map((h) => `<a class="l${h.level}" href="#${h.id}">${h.text.replace(/`/g, "")}</a>`).join("");

  const developer = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Integrate uHoney</title>
<meta name="description" content="Step-by-step integration guide for the uHoney merchant API.">
<style>
:root { --bg:#fbfaf7; --ink:#1d1b16; --muted:#5d594f; --line:#e2ddd1; --code:#f3f0e8; --accent:#a35d08; }
@media (prefers-color-scheme: dark) { :root { --bg:#16150f; --ink:#eeeadf; --muted:#a8a293; --line:#34312a; --code:#211f19; --accent:#f0a742; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
.wrap { display:grid; grid-template-columns: 240px minmax(0, 1fr); gap:40px; max-width:1120px; margin:0 auto; padding:40px 16px 80px; }
nav { position:sticky; top:24px; align-self:start; font-size:14px; }
nav a { display:block; color:var(--muted); text-decoration:none; padding:3px 0; }
nav a.l3 { padding-left:14px; }
nav a:hover { color:var(--accent); }
main { min-width:0; }
h1 { font-size:34px; line-height:1.2; margin:0 0 16px; }
h2 { font-size:24px; margin:48px 0 12px; padding-top:8px; border-top:1px solid var(--line); }
h3 { font-size:18px; margin:28px 0 8px; }
p, li { max-width:72ch; }
a { color:var(--accent); }
code { font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--code); padding:1px 5px; border-radius:4px; }
pre { background:var(--code); border:1px solid var(--line); border-radius:8px; padding:14px 16px; overflow-x:auto; }
pre code { background:none; padding:0; font-size:13px; }
.table { overflow-x:auto; }
table { border-collapse:collapse; font-size:14px; margin:12px 0; }
th, td { text-align:left; vertical-align:top; border-bottom:1px solid var(--line); padding:8px 10px; }
@media (max-width: 860px) { .wrap { grid-template-columns: 1fr; } nav { position:static; border-bottom:1px solid var(--line); padding-bottom:12px; } }
</style>
</head>
<body>
<div class="wrap">
<nav aria-label="Contents">${toc}<a href="{{AGENT_URL}}">Agent file</a><a href="{{API_URL}}/integrate/v1/openapi.json">OpenAPI contract</a></nav>
<main>
${html}
</main>
</div>
</body>
</html>
`;

  const llms = `# uHoney

> Detects AI agents on merchant websites and returns a verdict (human, agent, or agent→human handover) when someone presses Pay.

## Integration

- [Agent integration instructions]({{AGENT_URL}}): step-by-step procedure for coding agents integrating uHoney into a merchant site
- [Developer guide]({{DOCS_URL}}): the same steps for people
- [OpenAPI contract]({{API_URL}}/integrate/v1/openapi.json)
- [Changelog]({{TAG_BASE}}/integrate/changelog.md)
`;

  return {
    "agent.md": agent,
    "developer.html": developer,
    "llms.txt": llms,
    "changelog.md": read("changelog.md") + "\n",
    "openapi.json": readFileSync(path.join(ROOT, "packages/merchant-contract/openapi.json"), "utf8"),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  mkdirSync(OUT, { recursive: true });
  for (const [name, body] of Object.entries(buildDocs())) writeFileSync(path.join(OUT, name), body);
  console.log(`integration docs written to ${path.relative(ROOT, OUT)}`);
}
