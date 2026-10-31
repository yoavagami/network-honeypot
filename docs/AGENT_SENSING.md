# Agent sensing

Records everything the site can observe about *who* sent each request, so AI agents can be
detected in general and identified specifically where possible.

## What is captured

| Layer | Where | What |
|---|---|---|
| Network | `apps/honeypot/src/edge/` (edge sensor on :443) | TLS ClientHello → JA4 / JA4_r / JA3 / JA3N + raw lists; HTTP/2 opening → Akamai fingerprint (settings, window update, priority, pseudo-header order); HTTP/1.1 raw header names in original order and case; negotiated TLS version / cipher / ALPN; handshake timing |
| Request | `apps/honeypot/src/sensing/` → `request_signals` | Full header order and values (cookie / authorization / secret-looking values never stored); Web Bot Auth verification (RFC 9421, key fetched from the signer's directory); operator IP ranges (OpenAI, Anthropic, Google, Perplexity, Bing — refreshed every 12h); Tor; forward-confirmed rDNS; header/TLS consistency flags; **identity verdict** with reasons |
| Browser | `apps/honeypot/static/app.js` → `POST /api/v1/rum` → `client_signals` | Device/browser fingerprint (screen, GPU, fonts, canvas/audio hash, client hints, timezone…); automation tells (webdriver, CDP, Playwright/Puppeteer/Selenium globals, injected globals); agent DOM artifacts (`claude-agent-stop-container`, `pplx-agent-overlay-stop-button`, anything added to the page); behavior (mouse path, click offset from centre, typing without key presses, scroll, focus/visibility). Never records key values or field contents. |

Identity verdicts: `verified` (signature / IP list / rDNS proves the claim), `spoofed` (claim
contradicted), `claimed` (operator publishes no way to check), `agent_ip` (no claim, but an AI
operator's IP), `automation` (HTTP library / headless), `ai_app` (Claude desktop, Atlas favicon…),
`browser_inconsistent`, `browser`.

## Controlled runs

Add `?lab=<label>` to any URL (letters, digits, `.-_`). The browser keeps the label for 30 days
(cookie `hp_lab`) and every request and beacon is tagged with it — that's ground truth for
analysis. Use a new label per run, e.g. `chatgpt-agent-1`.

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
