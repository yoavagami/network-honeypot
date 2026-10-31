import type { Product } from "./catalog.js";

/** Product illustrations are drawn as SVG (no stock photos to license or fingerprint). */
export function jarSvg(p: Product): string {
  const { honey, lid, label } = p.colors;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420" role="img" aria-label="${p.name}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbf4e4"/><stop offset="1" stop-color="#f3e6c8"/></linearGradient>
    <linearGradient id="h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${honey}" stop-opacity=".85"/><stop offset=".45" stop-color="${honey}"/><stop offset="1" stop-color="${honey}" stop-opacity=".7"/></linearGradient>
  </defs>
  <rect width="420" height="420" fill="url(#bg)"/>
  <ellipse cx="210" cy="372" rx="120" ry="14" fill="#000" opacity=".08"/>
  <rect x="112" y="118" width="196" height="250" rx="34" fill="url(#h)"/>
  <rect x="112" y="118" width="196" height="250" rx="34" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="3"/>
  <rect x="132" y="138" width="18" height="200" rx="9" fill="#fff" opacity=".28"/>
  <rect x="124" y="76" width="172" height="50" rx="10" fill="${lid}"/>
  <rect x="124" y="114" width="172" height="10" fill="#000" opacity=".15"/>
  <rect x="140" y="196" width="140" height="104" rx="8" fill="${label}"/>
  <text x="210" y="236" text-anchor="middle" font-family="Georgia, serif" font-size="26" fill="#3b2a12">uHoney</text>
  <text x="210" y="266" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" letter-spacing="1" fill="#6b5a3a">${p.name.toUpperCase().replace(" HONEY", "")}</text>
  <text x="210" y="286" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#8a7a5a">RAW · NL</text>
</svg>`;
}

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#f2b631"/><text x="32" y="44" text-anchor="middle" font-family="Georgia, serif" font-size="36" fill="#3b2a12">u</text></svg>`;
