# Agent sensing

Records everything the site can observe about *who* sent each request, so AI agents can be
detected in general and identified specifically where possible.

## What is captured

| Layer | Where | What |
|---|---|---|
| Network | `apps/honeypot/src/edge/` (edge sensor on :443) | TLS ClientHello → JA4 / JA4_r / JA3 / JA3N + raw lists; HTTP/2 opening → Akamai fingerprint (settings, window update, priority, pseudo-header order); HTTP/1.1 raw header names in original order and case; negotiated TLS version / cipher / ALPN; handshake timing |
| Request | `apps/honeypot/src/sensing/` → `request_signals` | Full header order and values (cookie / authorization / secret-looking values never stored); Web Bot Auth verification (RFC 9421, key fetched from the signer's directory); operator IP ranges (OpenAI, Anthropic, Google, Perplexity, Bing — refreshed every 12h); Tor; forward-confirmed rDNS; header/TLS consistency flags; **identity verdict** with reasons |
| Browser | `apps/honeypot/static/app.js` → `POST /api/v1/rum` → `client_signals` | Device/browser fingerprint (screen, GPU, fonts, canvas/audio hash, client hints, timezone…); automation tells (webdriver, CDP, Playwright/Puppeteer/Selenium globals, injected globals); agent DOM artifacts (`claude-agent-stop-container`, `pplx-agent-overlay-stop-button`, anything added to the page); behavior (mouse-move counts, distance and speed — not the path itself; click offset from the target's centre; typing without key presses; scroll, focus/visibility). Never records key values or field contents. Every beacon is checked against the page it claims (`sensing/pageLoads.ts`): beacons for page loads never served to that visitor are stored as `bound = false` and left out of the score. |
| Rendering | `apps/honeypot/src/sensing/ladder.ts` → `client_signals` (kind `ladder`) | Per HTML page load: did the client render CSS, fetch the `<noscript>` image, run JavaScript — see [Rendering ladder](#rendering-ladder). |

Identity verdicts: `verified` (signature / IP list / rDNS proves the claim), `spoofed` (claim
contradicted), `claimed` (operator publishes no way to check), `agent_ip` (no claim, but an AI
operator's IP), `automation` (HTTP library / headless), `ai_app` (Claude desktop, Atlas favicon…),
`browser_inconsistent`, `browser`.

## Rendering ladder

Tells "fetched the HTML only" from "rendered CSS, no JS" from "ran JS" on a **single** page load,
so fetchers and LLM browse tools are recognised from their first page.

**How.** An `onSend` hook (`apps/honeypot/src/index.ts` → `applyLadder`) gives every full HTML
response a fresh page-load id, stored as `request_signals.data.pageLoadId`, and adds:

| Beacon | Markup | Fetched only when |
|---|---|---|
| `/assets/img/bg/<id>.png` | inline `<style>`: `background` of a clipped, `aria-hidden` `<span class="vh-anchor">` | the client computes CSS (never `display:none` — browsers skip backgrounds of elements without a box) |
| `/assets/img/px/<id>.gif` | `<img>` inside `<noscript>` | scripting is off — JS-disabled browsers, and HTML parsers (which treat `<noscript>` content as markup) |
| `/assets/img/sp/<id>.gif` | requested by `app.js` as soon as it runs (id from `<meta name="request-id">`) | JavaScript ran; `fp`/`behavior` beacons carry the same id (`pl`) and count too |

Each hit is a `client_signals` row of kind `ladder` (`data.rung` = `css` / `noscript` / `js`,
`page_load_id` = the id); responses are 1×1 images with `Cache-Control: no-store`. No migration.

**Rungs** (`packages/detection/src/renderingLadder.ts`). A page load is judged once it is *settled*
— 30 s old, or followed by another page:

| Arrived | Rung | Score signal (weight) |
|---|---|---|
| nothing | `html_only` | `html_only` (1.6 with a browser user-agent, else 1.0) — skipped if the visit fetched real subresources (`app.js`, CSS…): that's a browser blocking images |
| noscript only | `images_only` | `html_parser_images` (1.2) |
| CSS (± noscript) | `css_no_js` | `css_no_js` (0.8; noscript too = JS switched off) |
| JS, no CSS | `js_no_css` | `js_without_css` (1.2) — DOM emulator or image-blocking automation |
| CSS + JS | `ran_js` | — |

All four are "no real browser" signals: they never lift the "no AI evidence → Not sure" cap. For
visits without ladder data (before it shipped) the older `no_javascript` (≥ 2 pages) and
`no_subresources` checks still apply.

Verified with curl and headless Chrome (JS on → css + js; JS off via DevTools → css + noscript;
images off → only `app.js`, hence the subresource guard). Known benign `css_no_js`: Tor Browser's
safest mode and other JS-disabled browsers.

## Controlled runs

Create a **signed lab link** on the dashboard (Agents → Lab runs): label it
`<agent>-<scenario>-<n>` (e.g. `claude-chrome-checkout-1`) or `human-<browser>-<n>` for human
control runs, open the link in the browser or agent under test, and every request and beacon from
that browser is tagged with the label until the link expires (cookie `hp_lab`). Only signed runs
(`lab_verified`) are ground truth. A bare `?lab=<label>` still works for quick checks but is
recorded as *claimed* — anyone can type one, so it never feeds evaluation. Links are signed with
`LAB_LINK_SECRET` (`packages/detection/src/labToken.ts`), shared by the honeypot and admin-api.

## Report

```bash
infrastructure/aws/agent-report.sh
```

Runs `scripts/agent-report.sql`: labeled runs (who/when/how), what each page saw, unlabeled
AI-bot claims with verdicts, fingerprint clusters (one client behind many user-agents), DOM
artifacts.

## Edge sensor operations

- Runs as the `edge` service in `infrastructure/vps/docker-compose.tls.yml` (same image as the
  app), publishes 443, forwards to nginx's internal `listen 8443 proxy_protocol` server with the
  fingerprint in PROXY v2 TLV `0xE0`; nginx passes it on as `X-HP-Edge` and blanks that header
  everywhere else.
- Reloads the certificate every 6h.
- **Rollback** (nginx terminates TLS again): on the server, `infrastructure/vps/edge-rollback.sh`.
  A normal `deploy.sh` re-enables the sensor.

## uHoney shop (agent e-commerce flows)

`/` is now a small storefront (`apps/honeypot/src/shop/`, `routes/shop.ts`): two products, basket
(signed cookie), checkout in three steps (details → shipping → payment), confirmation. The Meridian
site moved to `/app`; its bait pages keep their URLs and are linked from the shop footer.

- Every step emits a `SHOP_*` event with the prices / totals shown or chosen — so "what the agent
  saw vs. what it paid" is answerable. Contact details are never stored: `/checkout/details` is
  excluded from body capture and only field fill-lengths / format checks are recorded.
- **Payments** go through `PaymentProvider` (`shop/payments.ts`), enabled via
  `SHOP_PAYMENT_PROVIDERS` (default `test_card,bank_transfer`). Neither accepts real payment data:
  the card form's inputs are never submitted and only published test numbers (4242…) pass; any
  other number is declined in the browser and only its length / Luhn validity is posted. Bank
  transfer neither asks for nor shows account details. A real provider (e.g. Stripe Payment
  Element, where card data goes browser → Stripe) is a new provider, not a checkout change.
- `SHOP_DEMO_NOTICE=false` hides the "demonstration store" line in the footer and terms.

## Agents page (dashboard)

`/agents` in the admin dashboard scores every **visit** (a session, or an actor's cookieless burst
within 30 minutes): probability it was an AI agent, a recommendation (**AI agent / Probably AI
agent / Not sure / Not AI agent**), a type (cloud browser agent, in-browser agent, user-triggered
fetcher, AI crawler, search crawler, AI app, browser automation, script, scanner, human) and the
signals behind it, each with its weight. Tabs: visits, per-request (each request with its visit's
score), lab runs. Visit detail shows network identity, the page-script fingerprint, the rendering ladder
(per page: CSS rendered / `<noscript>` image / JavaScript ran), behavior, the shop journey with
prices, and every request. Event detail pages get an "Agent analysis" panel.

Scoring is `packages/detection/src/agentScore.ts` with its signals in `signals.ts`. The honeypot's
scoring worker stores each visit's verdict in `visit_scores` as the visit happens (open visits are
rescored every ~30 s, and once more when they settle), so the list is an indexed query; the visit
detail page rescores on read. After changing a weight, bump `SCORER_VERSION` and run
`pnpm rescore --days N` (deploy.sh runs `--days 30`). Proof — verified signature / operator IP list / rDNS, or a known agent's DOM marker —
overrides the sum.

**Who was driving** (`packages/detection/src/pageControl.ts`). Each page load is judged on its own
as *agent*, *human*, *both* or *unknown* — automation signs: jump clicks (≤1 mouse event and
≤50 ms before the click; keyboard, touch and synthetic clicks excluded), form fields set by script
(input events with no `inputType` and no keys or pastes), scrolling with no wheel/key/touch/mouse;
human signs: mouse paths, wheel/trackpad, touch, clicks after a mouse path. Pages are ordered by
their first report (a back/forward-cache restore keeps an old page clock), and the visit gets a
control mode: **agent**, **human**, **agent → human** (an agent browses and fills checkout, a
person pays — the common agentic-commerce handover), **human → agent**, or **mixed**, with the
handover page. Once a visit is clearly agent-driven, human-input credit from the person's pages is
shown at weight 0, so a person finishing the checkout no longer cancels the agent's evidence. The
Agents list has a *Driven by* column and filter (`?control=hybrid` for any handover); the visit
page shows a per-page *Who was driving* table. Found on the lab run `claude-full-buy-3-11-11`,
which scored 0.13 before and 0.995 (agent → human at `/checkout/payment`) after.

**Server vs. page checks** (`pageConsistency.ts`): the page's user-agent vs. the request header,
`navigator.languages` vs. `Accept-Language`, the user-agent's OS vs. `navigator.platform` and
client hints, browser timezone vs. IP country (skipped behind VPNs/proxies), fingerprint
stability across page loads, and the claimed browser's fixed traits (vendor, productSub,
`window.chrome`, buildID, userAgentData). Shown as a table on the visit page and a *Checks* column
on the list. Automation without AI-specific evidence or a visibly driven browser is capped at
"Not sure". Weights are judgment until tuned on lab runs, so the page marks scores uncalibrated.
