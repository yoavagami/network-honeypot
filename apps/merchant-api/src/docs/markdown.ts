/**
 * Minimal Markdown → HTML for the integration guide (the subset docs/integrate uses: headings,
 * paragraphs, bullet and numbered lists with one nested level, fenced code, tables, inline code,
 * bold, links). Escapes everything else, so source text can never inject HTML.
 */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function inline(s: string): string {
  const parts = s.split(/(`[^`]+`)/g);
  return parts.map((p) => {
    if (p.startsWith("`") && p.endsWith("`") && p.length > 1) return `<code>${esc(p.slice(1, -1))}</code>`;
    return esc(p)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*|#[^)\s]*)\)/g, '<a href="$2">$1</a>');
  }).join("");
}

export const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function toHtml(md: string): { html: string; headings: Array<{ level: number; text: string; id: string }> } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const headings: Array<{ level: number; text: string; id: string }> = [];
  let i = 0;
  const isList = (l: string) => /^(\s*)([-*]|\d+\.)\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      out.push(`<pre><code${fence[1] ? ` class="language-${fence[1]}"` : ""}>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const text = h[2]!.trim();
      const id = slug(text);
      headings.push({ level: h[1]!.length, text, id });
      out.push(`<h${h[1]!.length} id="${id}">${inline(text)}</h${h[1]!.length}>`);
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && lines[i + 1]?.match(/^\s*\|[\s:|-]+\|\s*$/)) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(cells(lines[i++]!));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (isList(line)) {
      const items: Array<{ ordered: boolean; indent: number; text: string }> = [];
      while (i < lines.length && (isList(lines[i]!) || (lines[i]!.trim() && /^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const m = lines[i]!.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (m) items.push({ ordered: /\d/.test(m[2]!), indent: m[1]!.length, text: m[3]! });
        else items[items.length - 1]!.text += " " + lines[i]!.trim();
        i++;
      }
      const render = (start: number, indent: number): [string, number] => {
        const ordered = items[start]!.ordered;
        let html = ordered ? "<ol>" : "<ul>";
        let k = start;
        while (k < items.length && items[k]!.indent >= indent) {
          if (items[k]!.indent > indent) { const [sub, next] = render(k, items[k]!.indent); html = html.replace(/<\/li>$/, `${sub}</li>`); k = next; continue; }
          html += `<li>${inline(items[k]!.text)}</li>`;
          k++;
        }
        return [html + (ordered ? "</ol>" : "</ul>"), k];
      };
      out.push(render(0, items[0]!.indent)[0]);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|\s*\|)/.test(lines[i]!) && !isList(lines[i]!)) para.push(lines[i++]!.trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return { html: out.join("\n"), headings };
}
