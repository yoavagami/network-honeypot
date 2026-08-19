# Detection Strategy

## 1. Event taxonomy

Implemented as a TypeScript string-literal union + zod enum in `packages/types/src/events.ts`, so
adding a new type is a one-line change that immediately gets type-checked everywhere it's used.

```
HTTP_REQUEST                 -- baseline, every request
HTTP_ERROR                   -- 4xx/5xx response
AUTH_PAGE_VIEW
LOGIN_ATTEMPT
LOGIN_FAILURE
LOGIN_SUCCESS                -- against a synthetic account only
REGISTRATION_ATTEMPT
PASSWORD_RESET_ATTEMPT
API_REQUEST
API_ERROR
INVALID_ROUTE
INVALID_METHOD
INVALID_PARAMETER
PARAMETER_ENUMERATION
OBJECT_ENUMERATION
ID_ENUMERATION
PATH_ENUMERATION
FILE_ACCESS_ATTEMPT
ADMIN_PAGE_ACCESS
ADMIN_LOGIN_ATTEMPT
UPLOAD_ATTEMPT
SUSPICIOUS_UPLOAD
BOT_DETECTED
SCANNER_DETECTED
FUZZING_DETECTED
RATE_LIMIT_TRIGGERED
AUTOMATION_DETECTED
SESSION_CREATED
SESSION_CHANGED
COOKIE_ANOMALY
HEADER_ANOMALY
SUSPICIOUS_USER_AGENT
SUSPICIOUS_QUERY
SUSPICIOUS_PAYLOAD
ERROR_PROBE
TECHNOLOGY_ENUMERATION
ROBOTS_ACCESS
SITEMAP_ACCESS
API_DOCUMENTATION_ACCESS
HEALTH_ENDPOINT_ACCESS
HONEYPOT_TRIGGER
CANARY_TRIGGERED
ALERT_TRIGGERED             -- emitted when an alert threshold rule fires (Phase 2 delivery)
```

## 2. Two-tier detection engine

**Tier 1 — inline rules** (`packages/detection/src/rules/inline/*`), run synchronously in the
request hook, O(1) per request, no DB read required:

- Path/file signature match against a curated recon list (`.env`, `.git/*`, `wp-admin`, `.aws/*`,
  `id_rsa`, common backup/config filenames) → `HONEYPOT_TRIGGER` / `TECHNOLOGY_ENUMERATION`.
- Known scanner/library User-Agent substrings (`curl`, `python-requests`, `Go-http-client`,
  `Nikto`, `sqlmap`, `Nuclei`, headless-browser markers) → tags the event with a *signal*, not a
  verdict — contributes to Tier 2 scanner classification, never alone labeled `SCANNER_DETECTED`.
- Malformed input against the route's own zod schema → `INVALID_PARAMETER` / `API_ERROR`.
- Method not allowed on a matched path → `INVALID_METHOD`.
- No route matched → `INVALID_ROUTE`.
- Canary value present anywhere in the request (path, query, header, body key-shape match on
  known canary token format) → `CANARY_TRIGGERED`, always `critical` severity, always flushed
  ahead of the batch queue's normal ordering (see ARCHITECTURE §5 — canaries are never the class
  of event dropped under backpressure).
- `robots.txt`/`sitemap.xml`/`/api/docs` hits → `ROBOTS_ACCESS`/`SITEMAP_ACCESS`/
  `API_DOCUMENTATION_ACCESS` (benign by default, but timestamped precisely because they're the
  key input to "first contact" and "discovery funnel" analytics).

**Tier 2 — correlation rules** (`packages/detection/src/rules/correlation/*`), run by a background
worker on a short interval (default 5s) against each actor's recent window (in-memory ring buffer
per active actor, backed by a DB query for actors not currently in memory):

- **Reconnaissance**: ≥3 distinct recon-signature paths (see Tier 1 list) from one actor within 5
  minutes → `detections` row, type `reconnaissance`.
- **Sequential ID enumeration**: ≥5 requests to the same path template
  (`/users/:id`, `/api/v1/objects/:id`, ...) with monotonically-related numeric or predictable IDs
  within a short window → `ID_ENUMERATION`, `detections` type `enumeration`.
- **Parameter enumeration**: same endpoint hit with ≥8 distinct values for the same query
  parameter within a window → `PARAMETER_ENUMERATION`.
- **Fuzzing**: ≥20 distinct unmatched paths (`INVALID_ROUTE`) from one actor within 2 minutes, or
  high 4xx-ratio with high request-rate → `FUZZING_DETECTED`.
- **Scanner classification**: weighted combination of (known-tool UA substring, high request rate,
  broad unique-path count, near-zero time-between-requests variance, no referer/no
  accept-language diversity, malformed-request ratio) → confidence-scored `SCANNER_DETECTED`. No
  single signal reaches "high confidence" alone — see §4.
- **Auth probing**: ≥5 `LOGIN_FAILURE` within 5 minutes (velocity), or ≥3 distinct usernames
  attempted from one actor (enumeration), or ≥3 `PASSWORD_RESET_ATTEMPT` in 10 minutes →
  `detections` type `auth_probing`.
- **API probing**: unsupported method attempts, malformed JSON bodies, invalid object IDs
  requested, or ≥5 distinct `/api/*` sub-paths discovered within 2 minutes without ever having
  fetched `/api/docs` first (i.e., not following the documented discovery path — a signal of
  either blind fuzzing or prior knowledge) → `detections` type `api_probing`.

## 3. Risk scoring

`risk_score` (0-100) is a per-event *and* rolled-up per-actor value, computed as a weighted sum of
active signal flags, not a black box:

```
base: HTTP_REQUEST = 0
+10  known scanner/library UA substring present
+15  hit a Tier-1 recon-signature path
+20  INVALID_ROUTE / INVALID_METHOD / INVALID_PARAMETER
+25  ID_ENUMERATION / PARAMETER_ENUMERATION / PATH_ENUMERATION detection fired
+25  auth_probing detection fired
+30  api_probing detection fired
+35  ADMIN_PAGE_ACCESS with no prior referer chain from the public site (direct guess)
+50  SCANNER_DETECTED (Tier 2, confidence >= 0.6)
+90  CANARY_TRIGGERED
capped at 100
```
Weights live in one file (`packages/detection/src/scoring.ts`) as plain constants — tuning is a
data-driven exercise once we have real traffic, not a redeploy-the-architecture exercise.
Actor-level `risk_score` is a recency-weighted max/decay of its events' scores, not a raw sum, so
one old high-score event doesn't permanently pin an actor at "critical" forever.

## 4. Confidence, not certainty

Every classification (`bot_classification`, `SCANNER_DETECTED`, actor identity) carries:
```
confidence: number (0-1)
signals: string[]     -- exactly which contributing observations led here
```
The dashboard renders confidence as a labeled band (Low <0.5, Medium 0.5-0.8, High >0.8) next to
the classification, and clicking it always shows the `signals` list. No UI surface states a
classification as unqualified fact.

## 5. Bot / agent classification categories

```
human_browser
search_crawler          -- verified via known crawler UA + (optionally, Phase 2) reverse-DNS
ai_llm_agent             -- known AI-crawler/agent UA substrings (GPTBot, ClaudeBot, CCBot, etc.)
security_scanner
generic_bot
script_http_library
browser_automation        -- Playwright/Puppeteer/Selenium markers (webdriver flag, headless UA,
                              missing/mismatched fingerprint signals)
unknown_automation
likely_human
```
Browser-automation and "possible AI-assisted automation" labels are explicitly hedged per the
brief's §21 — navigation-pattern signals (systematic sequential exploration, robots.txt →
sitemap → docs → API in order, unusually regular timing) raise confidence but are always
presented as `Possible AI-assisted automation — Confidence: Medium`, never as proof.

## 6. Actor correlation algorithm (implementation detail for ARCHITECTURE §7)

```
on each request:
  signals = { visitor_id (cookie), ip_hash, ua_fingerprint, tls_tuple, accept_language }
  if visitor_id cookie present and matches an existing actor_signals row:
      actor = that actor                      # strongest signal
  else if (ip_hash, ua_fingerprint) matches an actor_signals row seen within CORRELATION_WINDOW:
      actor = that actor
  else:
      actor = new actor
  upsert actor_signals for every signal in `signals`
  recompute actor.confidence:
      high   if visitor_id cookie has been stable across >=2 sessions
      medium if only ip_hash+ua_fingerprint correlation, no cookie continuity
      low    if signals conflict (e.g. same ip_hash, wildly different ua_fingerprints in one window
             -- likely NAT/shared egress, not one actor) -- system still clusters but flags it
```

## 7. Extensibility

New detection rules are added as a new file under `rules/inline/` or `rules/correlation/`
implementing a shared `DetectionRule` interface (`evaluate(context): DetectionResult[]`) and
registered in an index array — no changes to the ingestion pipeline itself. This is the mechanism
Phase 5's "pluggable detection rule packs" builds on.
