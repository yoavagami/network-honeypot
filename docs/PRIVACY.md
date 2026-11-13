# Privacy Considerations

This system is publicly accessible and will incidentally observe real people (accidental
visitors, researchers, and yes, actual humans behind some "attacker" traffic). We collect the
minimum needed to answer the security-research questions this project exists to answer, not
everything technically available.

## What is collected, and why

| Data | Why | Retention |
|---|---|---|
| Raw source IP | Needed briefly for rate limiting, abuse response, and initial correlation | `RAW_IP_RETENTION_DAYS` (default 7 days), then NULL'd; `ip_hash` (HMAC, daily-rotating salt) retained for correlation without keeping the raw address |
| User-Agent string | Core to bot/scanner classification | Aligned with event retention (default 90 days) |
| Request path/query/method/headers (allowlisted) | The actual security signal this whole project exists to capture | Default 90 days, then partition dropped |
| Cookies (metadata only, not values) | Session/actor correlation | Same as above |
| Submitted usernames (login/register forms) | Credential-stuffing wordlist research value | Same as above |
| Submitted passwords | **Never retained in any form** — not even hashed. Only length bucket + complexity shape. | N/A — not stored |
| TLS version/cipher/ALPN | Passive fingerprinting signal, already visible to any TLS-terminating proxy | Same as above |
| Geolocation/ASN (Phase 2, opt-in) | Aggregate threat-intelligence value | Cached, aggregate-oriented; disabled by default (`GEOLOCATION_ENABLED=false`) |
| TLS ClientHello / HTTP/2 fingerprints (JA4, JA3, H2 settings), full header order and values (cookie/authorization/secret-looking values never stored) — `request_signals` | Telling AI agents, automation and real browsers apart (docs/AGENT_SENSING.md) | Event window (90 days); reverse-DNS names follow the raw-IP window (7 days) |
| Page-script device and browser fingerprint — `client_signals` kind `fp`: screen and window sizes, GPU renderer, canvas and audio hashes, installed-font list (30 probed fonts), timezone/locale, languages, client hints, CPU cores / memory, plugins, permission *states*, automation tells | Detecting headless/automated browsers and agents, and spotting the same automated client across visits | Event window (90 days) |
| Page-script behaviour — kind `behavior`: counts and timings of mouse moves, clicks (position relative to the clicked element, not the page), key presses (key *category* and intervals only — never the key or the text), scrolls, pastes, focus/visibility; agent-injected page elements | Telling a person from software operating the page | Event window (90 days) |
| Rendering-ladder beacons — kind `ladder` (did the page's CSS / `<noscript>` image / script load) | Recognising HTML-only fetchers from their first page | Event window (90 days) |
| Stored visit verdicts — `visit_scores` (probability, type, reasons, display IP) | The Agents dashboard | Event window; the display IP is cleared after the raw-IP window (7 days) |
| Signed lab runs — rows tagged by a lab link we minted ourselves (`lab_verified`) | Ground truth to measure the detector against | Kept past the event window — these are our own controlled test visits, not third-party visitors |
| Cookies we set: `hp_visitor` (random id, 90 days), `hp_session` (12 h), `hp_lab` (only when opened from a lab link; until it expires, max 30 days), shop basket/checkout cookies | Session and visit continuity | As stated |

## What we deliberately do not collect

- No cross-site tracking: the page script only runs on this site, sends only to this site
  (`/api/v1/rum`), and its identifiers are first-party only.
- No typed values: field contents, passwords, card numbers and individual keys are never sent by
  the page script — only counts, key categories and timings.
- No raw mouse paths, no geolocation coordinates (only the permission *state*), no WebRTC IP
  probing, no camera/microphone access.
- No tracking pixels, no third-party analytics, no ad-tech SDKs.
- No attempt to deanonymize visitors using external data broker lookups.
- *Correction (2026-11):* earlier versions of this document said there was no canvas
  fingerprinting or client-side collection beyond a normal site's. That stopped being true when
  agent sensing shipped (`apps/honeypot/static/app.js`); the table above is the accurate list.
  Under the EU ePrivacy rules, device fingerprinting for security purposes should be reviewed by
  counsel before relying on the "strictly necessary" exemption.

## Legal considerations

- This is a defensive security research deployment. Applicable considerations vary by
  jurisdiction of deployment and of visitors (e.g., GDPR if EU visitors are in scope) — the
  configurable retention windows and data-minimization defaults in this document are designed to
  make a GDPR-style "necessary and proportionate, minimized, time-limited" argument defensible,
  but this is not legal advice and deployment operators should have their own counsel review
  before a real public launch, especially regarding any jurisdiction-specific banner/notice
  requirements.
- A visible, honest notice (e.g. a footer link to a short "how this site handles data" statement)
  is recommended even though the site is a honeypot — deceiving visitors about the *nature* of
  the content is the point; deceiving them about *data handling* is not, and a truthful,
  boilerplate-looking privacy notice does not blow the honeypot's cover.

## Access controls & deletion

- Raw telemetry is reachable only via the admin dashboard/API, itself gated per SECURITY.md.
- An admin can look up and purge all rows associated with a given `ip_hash` or `actor_id` on
  request (deletion tooling tracked as a Phase 2 admin-API endpoint; the schema already supports
  it since everything keys off `actor_id`/`ip_hash`).

## Configuration surface

```
RAW_IP_RETENTION_DAYS=7
EVENT_RETENTION_DAYS=90
REQUEST_BODY_RETENTION=false
USER_AGENT_RETENTION_DAYS=90
GEOLOCATION_ENABLED=false
```
All defaults favor collecting less; operators who want longer retention for research purposes
opt in explicitly.
