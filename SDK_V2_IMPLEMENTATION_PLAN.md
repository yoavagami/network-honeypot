# uHoney SDK v2: gap review and layered implementation plan

Status: **Phase A implemented** on `feat/sdk-v2-phase-a` (rebased on `feat/hybrid-control` 2067ec7), tested end to end against a local Postgres; not yet committed properly, pushed or deployed. Phases B–E: not started. See "Phase A — done" below.
Date: 2026-11-13. Branch reviewed: `feat/agent-sensing` at `b9c3c97`.

Inputs:
- the code: `apps/honeypot`, `apps/admin-api`, `apps/admin-web`, `packages/{detection,db,types}`;
- every doc in `docs/`, plus `README.md`;
- the three planning docs: `SDK_COMBINED_SUMMARY.md`, `DEVICE_SDK_UPGRADE_PLAN.md` and
  `UHONEY_GAP_ANALYSIS.md`.

This document supersedes the phase lists in the other two plans. Where they disagree, this one
explains why.

---

## Phase A — done (2026-11-13)

| Item | Where |
|---|---|
| F1 signed lab links (P4, A3, D6, L1) | `packages/detection/src/labToken.ts`, `ingestion/capture.ts`, admin-api `routes/lab.ts`, `lab_runs`, dashboard Lab runs panel |
| F2/F3 stored scores (R2, R3, D5, A1, X10) | `apps/honeypot/src/scoring/visitScorer.ts`, `visit_scores`, `visit_requests`, `pnpm rescore`, admin-api list reads the table |
| F4 visit definition shared (R1) | `packages/detection/src/visits.ts`, `packages/db/src/visitRows.ts` |
| F5 beacon binding (S2, I2) | `sensing/pageLoads.ts`, `client_signals.bound`, `beacon_unbound` signal; `app.js` no longer invents page-load ids |
| F6 page_load_id column (D1) | migration 0012 |
| F7 hand-written fp projection removed | `visitRows.ts` loads full beacon data |
| F8 proof beacons high priority (I4) | `routes/rum.ts` |
| E2 beacon rate-limit zone | `infrastructure/nginx/*.conf` (`hp_beacon`) |
| E6 signal registry + catalogue | `packages/detection/src/signals.ts`, `/api/agents/signals`, `/agents/signals` |
| E7 golden fixtures + exporter | `packages/detection/test/fixtures/visits/` (7 synthetic), `export-fixture` |
| D9 retention for new tables | `packages/db/src/retention.ts` |
| D10 / E11 `hp_visitor` 90 days | `ingestion/capture.ts`, `docs/PRIVACY.md` |
| A8 admin-api tests | `apps/admin-api/test/` |
| O1–O4 docs | PRIVACY, ARCHITECTURE, ROADMAP, DATA_MODEL, DETECTION, AGENT_SENSING |
| Deploy | `LAB_LINK_SECRET` generated/appended, `pnpm rescore --days 7` after migrate |

Found while testing, fixed: shop page handlers and the ladder beacon route sent replies without
returning them, so Fastify logged "Reply was already sent / Cannot write headers" on every page.

**Open, not part of Phase A:** the same missing-`return` pattern remains in ~30 handlers
(`routes/pages.ts`, `admin.ts`, `crm.ts`, `wpInstall.ts`, shop asset routes) — log noise on the
deception pages; worth one mechanical pass. The nginx 429/503 log tailer half of E2 is not done.
The golden fixtures are synthetic until real lab visits are exported.

---

## 1. Where things actually stand

The planning docs are already partly out of date. Four commits since they were written have
shipped "Phase 0" of `UHONEY_GAP_ANALYSIS.md` and the rendering ladder:

| Item from the analysis | State in the code | Where |
|---|---|---|
| Score every page load, not `fps[0]` | **Done** for automation tells. The consistency checks still use `fps[0]` only. | `agentScore.ts`, `pageConsistency.ts:95` |
| Server ↔ page checks: UA, language, OS, client hints, timezone vs. country | **Done** | `pageConsistency.ts` `consistencyChecks` |
| Browser identity traits (vendor, productSub, `window.chrome`, `buildID`) | **Done** (a simplified B17) | `browserIdentity()` |
| Fingerprint stable across page loads | **Done** | check `fingerprint_stable` |
| Dead-centre clicks, click spread | **Done** | `centred_clicks`, `human_click_spread` |
| Think-then-act cadence | **Done** (from clicks only, not from move timing) | `inputFacts`, `think_then_act` |
| Typing corrections, paste-only input | **Done** | `no_typing_corrections`, `typing_corrections`, `paste_only_input` |
| VM tells from existing fields | **Done, then pruned**: voices, media devices and notification-permission tells were removed after they fired on real Chrome (`bb1067a`). | `environmentFacts` |
| Rendering ladder (CSS / noscript / JS beacons) | **Done** | `sensing/ladder.ts`, `renderingLadder.ts` |
| Dashboard: consistency table, ladder, environment, input sections | **Done** | `AgentVisitPage.tsx` |
| Named-agent probes (decoy field, handshake, Magnitude/Skyvern/Stagehand globals, Comet CSS) | **Missing** | Only 33 globals plus 3 DOM ids |
| Agent-readable canary (`/llms.txt`, invitation text) | **Missing**, decision still open | — |
| Input physics (coalesced events, pressure, timing stats, trajectory, scroll steps, `movementX` consistency, form-fill order) | **Missing** | `behavior` sends counts only |
| Integrity: iframe/worker lies, ~40 native functions, DRM, WebGPU, canvas seed | **Missing** | 1 native check, `globalsDiff` only |
| Payload validation, SDK versioning, build step | **Missing** | `rum.ts` accepts any JSON object under 64 KB for `fp`/`behavior` |
| Device clustering (`env_hash`, `net_hash`), known-cluster memory | **Missing** | `scripts/agent-report.sql` §4 only |
| Measurement loop: coverage matrix, human baseline, calibration, model registry | **Missing** | The "Lab runs" tab is a filtered visit list |
| Separate "automated" vs. "AI agent" scores | **Missing** | One probability plus a type, with a 0.69 cap |
| Stripe Radar comparison | **Missing** | `stripeTest.ts` re-fetches the PaymentIntent but doesn't read the risk level |

The gap is now mostly **new collection** (probes, physics, integrity) and **the measurement
loop**. There are also **structural problems in the current code** that the earlier plans don't
mention, and they should be fixed first (§2).

---

## 1b. End-to-end walkthrough: one visit, today

This follows a single visit through the system. **Gap** marks where it loses information or
correctness. The IDs point to the fixes in §4 and §4.11.

```
 ① edge :443 ──► ② nginx ──► ③ honeypot onRequest ──► ④ route + onSend ──► browser
   ClientHello     rate limit    cookies, actor,          HTML + ladder          ⑤ app.js
   H2 opening      X-HP-Edge     session, lab label       beacons, CSP           fp / behavior
        │                                                                          │
        └──────────── ⑥ onResponse: requests, events, request_signals ◄── ⑦ /api/v1/rum, ladder imgs
                                         │ in-process queue (high/low)
                                         ▼
                              ⑧ Postgres: request_signals, client_signals, events (SHOP_*)
                                         │
                ⑨ admin-api loadVisits → evidence() → scoreVisit()  (on every page view)
                                         │
                ⑩ admin-web: AgentsPage list · AgentVisitPage · AgentPanel on event detail
```

| Step | What happens (code) | Gap |
|---|---|---|
| ① Edge | `edge/sensor.ts` parses the ClientHello (JA4/JA3, full cipher, extension, group and sigalg lists), the H2 SETTINGS, window update, priority and pseudo-header order, H1 header names and **handshake timing**, then passes them to nginx in a PROXY v2 TLV. | Scoring uses only 3 facts from all this: GREASE present, `h2` offered, pseudo-order `m,a,s,p` (`headers.ts`). JA4 is never compared with what the claimed browser *version* sends, and H2 SETTINGS and timing are unused. → **E1** |
| ② nginx | `hp_general` 20 r/s, burst 40, **per IP, on every path**, including `/api/v1/rum` and the `/assets/img/{bg,px,sp}` ladder beacons. Rejected requests never reach the app (a known ROADMAP gap). | A fast agent, or a busy office or carrier NAT, can have its **beacons** rejected. The visit then looks like `html_only` or "no JavaScript", which is a false signal *against* the visitor. → **E2** |
| ③ onRequest | `capture.ts` sets `hp_visitor` (365 days), `hp_session` (12 h) and `hp_lab` (any `?lab=`), hashes the IP with a **daily-rotating** salt, and resolves the actor (visitor cookie, else IP hash + UA within a window). | Lab label is unauthenticated (F1). Because the IP hash rotates daily, cross-day "same origin" memory needs another key, which strengthens the case for `net_hash`/`device_hash` (D4, X6). |
| ④ Route + onSend | Shop pages emit `SHOP_*` events with prices and field fill lengths. `applyLadder` mints the page-load id, injects `<meta name="request-id">`, the CSS beacon and the `<noscript>` beacon. The CSP is strict (`default-src 'self'`). | The ladder hook is the right place for the canvas seed (P1). The Stripe Payment Element is a cross-origin iframe, so **behaviour inside the card form is invisible** to `app.js`. → **E4** |
| ⑤ app.js | ~1.2 s after load: one `fp` beacon. Behaviour snapshots every 15 s and on hide. A MutationObserver watches for agent DOM. Max 15 sends. | Counts only, no timing distributions, no probes, no integrity checks, no version, a random fallback page-load id (§4.1). No self-report when checks throw or the collector fails. → **E9** |
| ⑥ onResponse | `finalizeRequest` writes `requests` and `events`, then `collectRequestSignals` (Web Bot Auth, IP ranges, rDNS, Tor, header consistency, identity verdict) asynchronously → `request_signals`, **low priority**. | `pageLoadId` sits in jsonb (F6). Signal rows are dropped first under load (F8). |
| ⑦ Beacons | `rum.ts` accepts `fp`/`behavior` JSON objects up to 64 KB with no schema. `ladder.ts` records rung hits. | No validation, no binding to the served page, no server-side caps (F5, I1, I2, I5). |
| ⑧ Storage | Raw jsonb in `client_signals`. Retention: 90-day `DELETE`, rDNS redacted after 7 days. | Nothing derived or indexed per page load or per visit. No purge tool (D2, D5, D9). |
| ⑨ Scoring | admin-api loads the **oldest** 25k requests in the range plus all their beacons, builds visits (session segments, folded cookieless bursts), projects ~30 hard-coded fp fields, and runs `scoreVisit`: about **59 signals**, prior −1.2, proof shortcuts, 0.69 "no AI evidence" cap. | F2, F3, F4, F7. Weights live inline in one 400-line function, with **21 tests for 59 signals** and no real-visit fixtures. Journey use is limited to `fast_navigation` and `instant_checkout`. → **E3, E6, E7** |
| ⑩ Dashboard | List: bucket cards, filters, the Why-filter with wildcards, a Lab tab (a filtered list). Visit page: verdict hero, Why (flat list of weighted reasons), Network, Browser (first fp only), Consistency, Ladder, Environment, Input, Behavior, Shop, Requests. | No single **timeline** linking requests, beacons, clicks, pauses and shop steps. Reasons aren't grouped by question. No "would we still catch it without the proof?". Only the first page load's fingerprint is shown. No way for an analyst to **correct** a verdict. Nothing reaches Overview or Alerts (F10). → **E5, E8** |

---

## 2. Problems in today's code that the earlier plans miss

These sit underneath the SDK work. Building v2 on top of them would make the problems bigger.

| # | Problem | Evidence | Consequence |
|---|---|---|---|
| F1 | **Anyone can set a lab label.** `?lab=<anything>` from any visitor sets `hp_lab` for 30 days. | `capture.ts:89-92` | Today the labels are only displayed. Once they drive training, the release gate and `known_cluster`, an outsider can poison all three. |
| F2 | **The list scores the *oldest* 25,000 requests in the range, not the newest.** | `agents.ts` `ORDER BY r.created_at ASC LIMIT 25000` | On a busy 7-day range, the newest visits silently disappear from a list sorted by "last seen". The banner says "first 25,000", which is true but not what anyone wants. |
| F3 | **Scores exist only at read time.** Every list call reloads up to 25k requests plus *all* their client rows (no limit) and rescores everything in the admin-api process. | `loadVisits` | It's slow and grows with traffic. Nothing can query, alert, trend or remember a verdict: no "AI agent visits per day", no `known_cluster`, no coverage matrix in SQL. |
| F4 | **Visit building lives in an admin-api route file** (session segments, folding cookieless bursts, assigning beacons to segments) and has **no tests**. `apps/admin-api/test/` is empty. | `agents.ts:60-140` | The rules that define "a visit" can't be reused by a worker or the lab report, and regressions go unnoticed. |
| F5 | **Beacons aren't tied to the page they claim.** `pl` comes from the client and is never checked against the actor or session that was served that page-load id. A client without the meta tag gets a random ID. | `rum.ts:41`, `app.js:8` | Beacons can be forged or replayed into someone else's page load. The plan's `device_profiles` upsert on `page_load_id` would make this worse. |
| F6 | **`page_load_id` on requests is buried in jsonb** (`request_signals.data->>'pageLoadId'`), and `client_signals.page_load_id` has no index. | migration `0010`, `agents.ts` | Every page-load join is a jsonb extract plus a scan. |
| F7 | **The client-signal field list is hard-coded in SQL in admin-api.** The scorer only sees fields listed in the `jsonb_build_object(...)` projection. | `agents.ts` `CASE WHEN kind = 'fp'` | Every new SDK field needs a matching admin-api SQL edit, or the scorer silently never sees it. |
| F8 | **Beacons are low-priority in the queue**, so they're the first thing dropped under load, including a known agent's DOM-marker beacon. | `rum.ts`, `ladder.ts` `priority: "low"` | Proof-level evidence can be lost exactly during a burst. |
| F9 | **The docs contradict the code.** | See §9.6 | Legal and privacy risk, and confusing for reviewers. `PRIVACY.md` says "no canvas fingerprinting, no invasive client-side scripts". |
| F10 | **Agent verdicts are invisible outside the Agents page.** Overview, Actor profile, Live stream and Alerts don't know about them. | `OverviewPage.tsx`, `ingestion/alerts.ts` | No alert on a proven agent reaching checkout, and no agent trend on the overview. |

---

## 3. Corrections to `DEVICE_SDK_UPGRADE_PLAN.md`

Carried into the layered plan below:

1. **The decoy-field trap (AG2) and global polling (AG4–AG6) can't see extension-based agents.**
   Content scripts run in an isolated JS world. They don't see our `getAttribute` override or
   our globals. The probes catch agents that inject into the page itself (`page.evaluate`, init
   scripts: browser-use, Stagehand, Skyvern, Magnitude). Extension agents (Claude in Chrome,
   Comet) are caught by DOM/CSS markers and the `postMessage` handshake (AG1, AG3, AG7). The
   decoy must also **stay armed** (not "removed after the check"), because a scan can happen at
   any time.
2. **Drop the battery, voices and media-device VM tells.** `bb1067a` already proved the last two
   fire on real Chrome, and battery 100% / ∞ is every desktop PC. "No Widevine on Chrome" also
   fires on Chromium and Electron: weight it lightly and test it on real browsers first.
3. **`known_cluster` must use agent-labelled or proven clusters only**, keyed on a fine
   `device_hash` (or `net_hash` + `env_hash`), never the coarse `env_hash` alone ("Chrome / macOS
   / Apple GPU" covers millions of people).
4. **Canvas seed check:** pixels must use alpha 255 (premultiplied-alpha rounding otherwise looks
   like noise). The seed must be bound to the server-minted page-load id we already have, not a
   new request ID.
5. **Migration grants:** the model activate endpoint needs `UPDATE` on `detection_models` for
   `admin_api_role`, and the training script needs `INSERT` (or runs as the migration superuser,
   like retention does).
6. **esbuild can't fully convert code to ES5.** Write the modules in ES5 (the current style) and
   use esbuild only to bundle and minify, or use SWC. Safari has no `requestIdleCallback`, so
   fall back to `setTimeout`.
7. **CSP:** `default-src 'self'` with no `worker-src` blocks `blob:` workers. The DV2 Worker must
   be a same-origin file (`/assets/w.js`).
8. **Retention:** the plan's 180 days contradicts `PRIVACY.md` (90 days, aligned with events). Keep
   90 by default. Keep lab rows longer only for **authenticated** lab labels (F1).
9. **The release gate needs statistical power.** "≤ 2% false positives" can't be measured on 8
   human runs. Define it as an upper confidence bound over a minimum count (§8).

---

## 4. The plan, layer by layer

Each item has an ID used in the phase table (§10). "Why" explains what it buys and what breaks
without it.

### 4.1 SDK: page collector (`apps/honeypot/static/app.js` → `apps/honeypot/sdk/`)

| ID | Add | Why |
|---|---|---|
| S1 | **Module layout and build.** `sdk/src/{core,probes,integrity,env,canvas,behavior,motion}.js` in ES5, bundled by `npm run build:sdk` (esbuild bundle+minify, IIFE) into `static/app.js`. The SDK version and content hash are stamped into the file and sent as `sv`/`sdk` on every beacon. Keep the "Meridian client bundle" disguise. | The current single 370-line file can't grow into five beacon kinds without regressions. Versioning lets us compare v1 and v2 traffic and reject stale caches. |
| S2 | **Core.** Uniform check result `{s, v}` (`0` ok, `-1` unsupported, `-2` blocked, `-3` timeout, `-4` threw); a per-module timeout and CPU budget; `requestIdleCallback` with a `setTimeout` fallback; a per-kind send budget (fp 1, integrity 1, probe 3, behavior 15, motion 20); **no random-ID fallback** (if the meta tag is missing, send `pl: null` and let the server treat it as unbound). | "Threw" and "blocked" are signals in themselves, and today they collapse into `null`. Removing the random fallback closes F5 on the client side. |
| S3 | **`probes.js` (new `probe` kind).** (a) Decoy input with an instrumented `getAttribute`/`getBoundingClientRect` that checks the caller stack for DOM-scanner names (`isInteractiveElement`, `buildDomTree`, `highlightElement`…). Kept `aria-hidden`, `tabindex=-1`, `inert`, off-screen but **not zero-size**, armed for the whole page life. (b) `postMessage` handshake ping, listening for known agent replies. (c) Polled globals for 10 s: the full C1 list plus `__stagehandInjected`, `__magnitudeShadowDOMAdapterInjected`, Skyvern's function set, the ChromeDriver `cdc_` regex, CEF/Awesomium/Nightmare. (d) All `pplx-agent-*` ids, Comet `--sidecar-*` CSS variables, and the Claude in Chrome ids. Send **immediately on the first hit** (high priority, §4.3), plus a summary at 10 s. | This is the highest-precision evidence we can get and maps straight to "proven". Today we can name only 2 agents from the page. The isolated-world limit (§3.1) decides which agents each probe can catch. |
| S4 | **`integrity.js` (new `integrity` kind, once).** `toString` plus descriptor checks on ~40 commonly patched APIs (EN1, B21); getters defined on the instance instead of the prototype (EN2); fresh iframe vs. top page for navigator/screen/`Intl` fields (B24, reusing the `globalsDiff` iframe); main thread vs. Worker WebGL vendor and renderer (DV2, same-origin `/assets/w.js`); `webdriver` tri-state (C2); missing-feature count (C3); error-stack format class (B23). | Stealth tools patch one context. Asking the same question in two places is the cheapest lie detector, and it catches stealth Playwright, which today often ends up "not sure". |
| S5 | **`env.js` (inside `fp`).** EME key-system support flags (Widevine, PlayReady, ClearKey, FairPlay); WebGPU adapter (`isFallbackAdapter`, vendor, architecture); WebGL extension bitmask; codec bits; WebAuthn `getClientCapabilities()` flags; heap limit; keyboard-layout hash; maths/CSS precision; text metrics. **Remove** the battery read, which is used by nothing and was a weak tell. | Headless and cloud-browser tells beyond the software GPU, plus stable inputs for `env_hash`/`device_hash` (§4.4). |
| S6 | **`canvas.js`.** Keep the hash. Add a seeded 16×16 grid with alpha 255, seed = HMAC(secret, page-load id) in `<meta name="hp-cs">`, sent back as `{pixels}`. | Detects canvas noise (Brave, anti-detect browsers) on the server, and proves the beacon came from a page we served (F5). |
| S7 | **`behavior.js` (extended).** `[trusted, untrusted]` counts for ~40 event types (BH1); coalesced-events histogram and `pointerrawupdate` presence (BH2); pressure and `pointerType` stats (BH3); move-interval stats: mean, sd, p10/p50/p90, drop ratio, longest evenly spaced run (BH4); `movementX/Y` vs. `clientX/Y` mismatch count; scroll delta and interval spread (fixed-step scrolling); **form-fill sequence**: focus order vs. DOM order, focus method (pointer / Tab / programmatic), time per field, autofill detected, Backspace count. Values are never collected. | This is the core of "is a human driving?". Today we have counts, max speed and clicks. Think-then-act is currently derived from clicks only. Adding still-cursor time from move timing makes it far stronger. |
| S8 | **`motion.js` (new `motion` kind).** Packets of 50 `pointermove` samples → aggregated speed, acceleration, jerk, curvature and straight-line deviation; click approach (deceleration, overshoot, dwell in the last 300 ms). **Features only.** Optional: raw paths for **authenticated** lab runs only (§4.9), so the feature set can be re-derived later. | Training data for our own model (§4.6). Storing raw paths only for lab runs keeps privacy intact while still letting us iterate on features. |

### 4.2 Pages and serving (`apps/honeypot/src/render`, `src/shop`, `src/index.ts`)

| ID | Add | Why |
|---|---|---|
| P1 | Add `<meta name="hp-cs">` (canvas seed) next to `request-id` in `injectLadder`, so every HTML page gets it in one place. | Reuses the existing onSend hook. No template changes. |
| P2 | Serve `/assets/w.js` (Worker probe) and give the SDK a content-hashed URL or `ETag`. | Required by CSP (§3.7). The hash avoids stale caches mixing v1 and v2. |
| P3 | **Agent-readable canary** (decision D1): a visually hidden, `aria-hidden` neutral note plus `/llms.txt` inviting AI assistants to open `/agents/hello?ref=<page-load id>`. Wording must never change the user's task or ask for data. | It's the only AI-specific evidence available for no-JS fetchers, which today are capped at "not sure". |
| P4 | Signed lab links: `?lab=<label>.<exp>.<hmac>` minted by an admin-api endpoint (§4.7). Unsigned `?lab=` is still recorded, but as `lab_claimed`, never as ground truth. | Fixes F1 without breaking today's manual workflow. |

### 4.3 Ingestion (`src/routes/rum.ts`, new `src/sensing/client/*`)

| ID | Add | Why |
|---|---|---|
| I1 | **Per-kind zod schemas** (`client/schema.ts`): `fp`, `behavior`, `probe`, `integrity`, `motion` (ladder stays as it is). Size caps per kind (fp 32 KB, motion 16 KB, others 8 KB); unknown fields dropped; strings truncated; `sv` required for v2, while v1 is accepted and marked `sv = 1`. | Today any JSON object up to 64 KB lands in jsonb. Validation is also a signal: a malformed beacon from a "browser" is a forged beacon. |
| I2 | **Page-load binding.** On every beacon, check that `pl` was minted for this actor/session (an in-memory LRU of minted IDs → actor, falling back to a `request_signals` lookup). Store `bound: true/false` on the row. Unbound beacons are kept but never count as evidence *for* "human". | Fixes F5 with data we already have. It's cheaper and stronger than relying on the canvas HMAC alone. |
| I3 | **Canvas seed check** (`client/canvasSeed.ts`) → `canvas_noise: clean | noise | mismatch_seed`. | Server-side B1 check. A seed mismatch means the beacon was forged. |
| I4 | **Priority:** `probe` beacons and any beacon carrying a known artifact are enqueued `high`. | Fixes F8: proof-level evidence must never be the first thing dropped. |
| I5 | **Per-page-load and per-actor send caps** on the server (not just the client's `MAX_SENDS`). | One actor rotating `pl` values could otherwise flood `client_signals`. |
| I6 | **Derivation at ingest** (`client/derive.ts`, pure, in `packages/detection`): raw beacons → `lie_flags[]`, `env_class`, `probe_agent`/`probe_method`, `input_synthetic`, `device_hash`, `env_hash`. Upserted into `device_profiles` keyed on **(`actor_id`, `page_load_id`)**, only for bound beacons. | Turns raw jsonb into indexed, queryable facts. Removes F7, since the scorer reads derived columns instead of a hand-maintained SQL projection. |

### 4.4 Data layer (`packages/db/migrations/0012_device_sdk_v2.sql`, `schema.ts`)

| ID | Add | Why |
|---|---|---|
| D1 | `request_signals.page_load_id text` (promoted from `data`, backfilled) + index; `client_signals.page_load_id` index; `client_signals` + `schema_version`, `sdk_version`, `bound boolean`. Indexes built `CONCURRENTLY`, outside the migration transaction. | Fixes F6. `CONCURRENTLY` avoids locking `client_signals` while it's live. |
| D2 | `device_profiles`, PK (`actor_id`, `page_load_id`), with the columns from the device plan, plus `bound`, `canvas_noise`, `sdk_version`. | One indexed row per page load: the basis for clustering, coverage and fast scoring. |
| D3 | `motion_packets` (features only, plus `feature_set`) and, optionally, `lab_motion_raw` (authenticated lab runs only). | Model training without raw paths for the public. |
| D4 | `request_signals.net_hash` (JA4 + H2 fingerprint + header-order hash). | Shows the same agent stack behind rotating IPs. Today these are three separate columns. |
| D5 | **`visit_scores`**: `visit_id`, `scorer_version`, `computed_at`, `actor_id`, `session_id`, `first_at`, `last_at`, `lab_label`, `lab_verified`, `probability`, `automation_probability`, `bucket`, `type`, `agent`, `proven`, `reasons jsonb`, `signals text[]`. Indexes on (`last_at`), (`bucket`, `last_at`), (`lab_label`), GIN(`signals`). | Fixes F3. The list becomes one indexed query. Coverage, trends, alerts and `known_cluster` become plain SQL. |
| D6 | `lab_runs`: `label`, `agent`, `scenario`, `kind` (agent/human), `created_by`, `created_at`, `expires_at`, `notes`. | Ground truth gets an owner, a type and an expiry instead of a free-text cookie. |
| D7 | `detection_models` (as in the device plan) with the corrected grants (§3.5). | Model registry and audited activation. |
| D8 | View `device_clusters` over `device_profiles`. Make it materialized and refresh it from the scoring worker once volume makes it slow. | The Devices page. |
| D9 | **Retention:** extend `retention.ts` to `device_profiles`, `motion_packets`, `visit_scores` (event retention, 90 days by default), with an exception for `lab_verified` rows. Add an **actor purge** covering every table (promised in `PRIVACY.md`, never built). | The new tables would otherwise grow without limit, and the privacy doc makes a promise the code doesn't keep. |

### 4.5 Results generation: from evidence to a stored verdict

Today: admin-api builds visits and scores them on every page view. Proposed:

| ID | Add | Why |
|---|---|---|
| R1 | **Move visit building into `packages/detection/src/visits.ts`** (session segmentation by lab label and 30-minute gaps, cookieless-burst folding, beacon → segment assignment) and the `evidence()` mapping, with unit tests. | Fixes F4. One definition of "a visit" for the worker, the API and the lab report. |
| R2 | **Scoring worker** next to `correlationWorker.ts`: every ~30 s, find visits with new requests or beacons, rebuild and score them, and upsert `visit_scores`. A visit is rescored while it's open and once more after it settles (30 min idle). | Scoring once and reading many times. The scorer stays pure, so changing weights means bumping `SCORER_VERSION` and running `pnpm rescore`. |
| R3 | **Where it runs and which role.** Run it in the honeypot process with a `visit_scores` insert/update grant. A compromised honeypot can already forge raw telemetry, so this adds no new trust. admin-api stays read-only on telemetry, as `ARCHITECTURE.md` §6 requires. | Keeps the existing isolation model intact. |
| R4 | Keep **on-read scoring for the visit detail page** (always fresh, full reasons), and use the stored row for lists and aggregates. | Detail pages are cheap (one visit). Lists need indexes. |

### 4.6 Detection and scoring (`packages/detection/src/agentScore.ts`)

| ID | Add | Why |
|---|---|---|
| X1 | **Two outputs:** `automation_probability` (is a machine driving?) and `ai_probability` (is it an AI agent?), with `type` kept. Replace the 0.69 cap with this split. | Merchants act differently on scalper bots and shopping agents (D2 in the gap analysis). The cap currently hides that distinction instead of reporting it. |
| X2 | `agent_probe` proof signal (weight 9, finish 0.98), on the same path as `agent_dom_marker`. Extend `KNOWN_ARTIFACT_AGENT` and `AGENT_KIND` with browser-use, Stagehand, Skyvern, Magnitude, Manus, Comet. | Named agents from S3. |
| X3 | Integrity signals: `lie_detected` (iframe/worker/native/instance-getter; 1.2 + 0.4 per extra flag, max 3) and `headless_env` (fallback WebGPU or SwiftShader **plus** a C3 count ≥ 3; no EME alone is a weak 0.4). | Stealth automation. Weighted to avoid false positives on Chromium, Brave and Electron. |
| X4 | Input signals: `synthetic_input` (BH2–BH4, `movementX` mismatch, fixed-step scroll, programmatic focus, DOM-order fill), and a **stronger `human_input`** (coalesced samples + jitter + click approach + corrections + autofill, −1.5). | Today strong evidence *for* "human" is rare, so real shoppers land on "not sure". Precision on humans matters most. |
| X5 | `beacon_unbound` / `beacon_forged` (I2, I3); `canvas_noise` (−0.3). | Forged beacons stop counting as human evidence. |
| X6 | `known_cluster` (+1.0): `device_hash` or `net_hash` previously seen in a **verified agent lab run** or a **proven** visit, read from `visit_scores` and `device_profiles`. | Memory across cookie resets and IP rotation, without false positives from human control runs. |
| X7 | `agent_canary` (AI-specific, +3.0) if P3 is approved. | Lifts no-JS LLM fetchers out of "not sure". |
| X8 | `motion_model`: logit of `motion_prob`, capped at ±3, only once a model is active (§4.9). | Learned input physics. |
| X9 | Run the consistency checks over **every** fp, not `fps[0]`. | Finishes the Phase 0 promise. A mismatch on page 3 is still a mismatch. |
| X10 | `SCORER_VERSION` constant, stored with each `visit_scores` row. | Rescoring and A/B comparison of weight changes. |

### 4.7 Admin API (`apps/admin-api/src/routes/`)

| ID | Add | Why |
|---|---|---|
| A1 | `GET /api/agents/visits` reads `visit_scores` (newest first, keyset pagination, filters as SQL). Fixes F2 and F3. Adds filters for probe agent, env class, input class and automation-vs-AI. | Correct and fast lists. |
| A2 | `GET /api/agents/visits/:id` adds `profiles` (`device_profiles`), `probes`, `integrity`, `motion` summaries and binding status. | Data for the new visit sections. |
| A3 | `POST /api/lab/runs` (mint a signed lab link, superadmin or analyst) and `GET /api/lab/runs`. Audited. | Closes F1 from the admin side. |
| A4 | `GET /api/lab/coverage`: label × signal matrix and final bucket per run, from `visit_scores.signals`. | "Which agents do we catch, and how?" |
| A5 | `GET /api/devices`, `GET /api/devices/:hash`. | Clusters. |
| A6 | `GET /api/models`, `POST /api/models/:v/activate` (superadmin, audited). | Model registry. |
| A7 | `DELETE /api/actors/:id/data` (superadmin, audited) across every telemetry table. Needs a narrow, purpose-built `DELETE` grant, or a superuser CLI like `retention.ts`. | `PRIVACY.md` promise. The CLI form keeps admin-api read-only. |
| A8 | **Tests for admin-api** (there are none): visit loading, filters and lab minting. | F4. |

### 4.8 Dashboard (`apps/admin-web/src/pages/`)

| ID | Add | Why |
|---|---|---|
| W1 | **AgentsPage:** separate **AI agent** and **Automated** columns; Probe, Env and Input badges; filters; real pagination instead of the 25k banner. | Shows the X1 split. |
| W2 | **AgentVisitPage**, new sections between Browser and Behavior: **Agent probes** (which fired, ms after load, method); **Integrity** (✓/✗ per check, mismatched values side by side); extend the existing **Environment** section (DRM, WebGPU, canvas noise, private mode, `env_class`); **Input physics** (move-interval histogram, coalesced-events histogram, jitter gauge, think-pause timeline, click-spread plot, form-fill order, per-packet `motion_prob`); beacon binding status. | Explains *why*, one finding per row, in the existing tone. |
| W3 | **Lab page** (replacing the Lab runs tab): mint signed links, the run list, and the **coverage matrix** (runs × signals, coloured where a signal fired, final bucket, humans vs. agents separated). | The measurement loop's main view. |
| W4 | **DevicesPage:** cluster list and drill-down (sessions, agents, labels, what makes the cluster unusual). | Spotting the same cloud-browser image. |
| W5 | **ModelPage** (superadmin): versions, AUC, per-label precision/recall, human false-positive bound, activate. | Gated model rollout. |
| W6 | **Outside the Agents page:** an Overview card (AI agent / automated / human visits over time, from `visit_scores`); an Agent verdict on ActorProfile; alert rules for "proven AI agent reached checkout" and "new agent cluster" in `ingestion/alerts.ts`. | Fixes F10. Agent findings become part of the SOC workflow instead of a separate island. |

### 4.9 Lab, training and evaluation

| ID | Add | Why |
|---|---|---|
| L1 | Signed lab runs (P4, A3, D6), naming `<agent>-<scenario>-<n>` and `human-<browser>-<n>`. | Trusted ground truth. |
| L2 | A **run matrix per release**. Agents: Claude in Chrome, ChatGPT agent, Gemini agent, Comet, browser-use, Skyvern, Stagehand, Playwright/Puppeteer (headed, headless, stealth), curl/httpx, Claude/ChatGPT web fetch. Humans: Chrome, Safari, Firefox, Brave, Edge, iOS Safari, Android Chrome, plus one with a privacy extension. Flow: home → product → cart → checkout → Stripe test payment. | Coverage across both the agents we must catch and the humans we must not flag. |
| L3 | **Release gate:** for the human false-positive rate, the upper 95% bound must be ≤ 2%. That means about **150+ human page loads** across the browser list (plus seeded human sessions from consenting testers). Per-agent recall must not drop vs. the previous `SCORER_VERSION`. | A gate on 8 runs measures nothing. |
| L4 | `scripts/lab-report.ts` (the coverage matrix in markdown for PRs, replacing parts of `agent-report.sql`) and `scripts/rescore.ts`. | Repeatable evaluation. |
| L5 | `scripts/train-motion-model.ts`: logistic or small GBM on `motion_packets` from verified runs, holding out by run, writing to `detection_models`. Also a **weight calibration** fit of the existing log-odds weights on verified runs, flipping `calibrated` per scorer version. | Turns guessed weights into measured ones. |
| L6 | Stripe Radar `risk_level` stored on the `SHOP_PAYMENT_*` event metadata in test mode, shown next to our verdict. | An outside opinion to compare against. |
| L7 | A Playwright fixture in CI: load the shop headless, headed and stealth, and assert which flags fire. Plus a CPU and size budget test for the SDK (< 50 ms, < 35 KB gzipped). | Regression safety for the SDK. |

### 4.10 Privacy, docs and operations

| ID | Add | Why |
|---|---|---|
| O1 | **Rewrite `PRIVACY.md`** to match reality: canvas/audio/font fingerprinting, behaviour timings, motion features, retention per table, lab exceptions, the purge tool. Add a truthful footer "how this site handles data" notice, as the doc itself recommends. | It currently says the opposite of what `app.js` does. This is the biggest legal exposure in the repo. |
| O2 | Update `ARCHITECTURE.md` §8 / §10 and `ROADMAP.md` Phase 3: JA4/JA3/H2 fingerprinting **is** implemented (edge sensor). | Same doc drift, in the other direction. |
| O3 | Add `request_signals`, `client_signals` and the new tables to `DATA_MODEL.md`, and `agentScore` to `DETECTION.md`. Fix `AGENT_SENSING.md`: "mouse path" isn't collected, only counts. | Reviewers rely on these docs. |
| O4 | Mark `UHONEY_GAP_ANALYSIS.md` "Phase 0 and the rendering ladder shipped". Archive `DEVICE_SDK_UPGRADE_PLAN.md` as superseded by this file. | One source of truth. |
| O5 | Metrics: `beacons_received_total{kind}`, `beacons_rejected_total{reason}`, `beacons_unbound_total`, `scoring_lag_ms`, `visits_scored_total`. | Observing the new pipeline, in the style of `ARCHITECTURE.md` §11. |

### 4.11 Additions from the full code walkthrough (§1b)

These items aren't in either earlier plan. They come from reading the edge sensor, nginx, the
shop flow, the scorer and the dashboard end to end.

| ID | Layer | Add | Why |
|---|---|---|---|
| **E1** | Edge → scoring | **Use the TLS/H2 data we already capture.** (a) A `browser_net_profiles` reference built automatically from verified **human** lab runs, mapping (browser family, major version) → expected JA4 cipher/extension sets, H2 SETTINGS, window update and pseudo-order. Then a `net_profile_mismatch` signal ("claims Chrome 131, sends a TLS/H2 opening no Chrome 131 sends") replaces the GREASE-only check. (b) `net_hash` (D4). (c) RTT fusion: edge `handshakeMs` vs. the page's own measured beacon round trip and `navigator.connection.rtt`. A large gap means a proxy or relay between the browser and us. | It's all collected already and only 3 bits are used. A version-aware TLS/H2 match is one of the hardest signals for stealth tools and cloud browsers to fake. |
| **E2** | nginx | Give `/api/v1/rum` and `/assets/img/{bg,px,sp}/` their own `limit_req` zone with a higher burst. Ship nginx's 429/503 lines into ingestion as a `rate_limited` fact per IP hash and minute (the ROADMAP's log-tailer). The scorer skips the ladder and `no_javascript` verdicts for page loads in a rate-limited window. | Prevents false "HTML only" / "no JavaScript" signals caused by our own rate limiting, and closes the known ROADMAP gap. |
| **E3** | Scoring: journey | New journey signals from `SHOP_*` data we already store: `hallucinated_sku` (`SHOP_CART_ERROR` unknown SKU, or 404s on guessed product URLs: an LLM inventing links, AI-specific); `policy_read` (terms/shipping pages before paying: common for agents told to check policies, weak); `details_retry` (several `CHECKOUT_DETAILS_INVALID` with growing fill sets); `card_cycling` (≥ 3 declines with different test cards: **card testing, a script and not an AI**, sets type `script`); `price_consistency` (paid total ≠ total shown, a tampered request). | The shop journey is uHoney's unique layer, and today the scorer uses 2 facts from it. The card-testing pattern in particular separates fraud bots from shopping agents. |
| **E4** | SDK + shop | Stripe blind spot: record focus/blur on the Payment Element container, time from the payment page shown to `confirmPayment`, and whether the card iframe ever had focus (an agent that pastes card data via the API instead of the iframe never focuses it). | The most valuable step of the journey is currently a black box. |
| **E5** | Dashboard: visit | **Unified timeline**: one time axis with page loads (with ladder rung), beacons, clicks (with think pauses shaded), key bursts, scroll, visibility changes, probe hits and shop steps. It replaces reading five separate panels to reconstruct what happened. Also: group **Why** by the three questions (Who / Human driving? / Environment real?); a **"without proof" counterfactual** (rescore with proof signals removed, which is cheap because the scorer is pure: "would still be caught: yes, P = 0.91"); fingerprint **per page load** instead of only the first; an audited **raw-beacon drawer**. | This is how analysts actually check a verdict. The counterfactual shows whether detection survives once an agent changes its DOM marker, which is the robustness claim in `UHONEY_GAP_ANALYSIS.md` §7. |
| **E6** | Scoring structure | **Signal registry**: move the 59 signals into `signals.ts` (id, group, weight, `aiSpecific`, `scriptOnly`, description, the question it answers), so the `AI_SPECIFIC`/`SCRIPT_ONLY` sets and the weights live in one place. Calibration (L5) then writes a weights file per `SCORER_VERSION`, and the dashboard gets a **Signals catalogue** page: every signal, how often it fires, and on which lab labels and human runs. | Weights scattered inline can't be calibrated or audited. The catalogue shows dead signals and noisy ones at a glance. |
| **E7** | Tests | **Golden visit fixtures**: export real lab visits as redacted `VisitEvidence` JSON into `packages/detection/test/fixtures/`, one per agent and human browser, each asserting its bucket and type. `pnpm rescore --diff` shows which fixtures change bucket after a weight change. | 21 tests for 59 signals, all synthetic. Real fixtures catch regressions such as the voices and media-devices false positive *before* deploy, not after (`bb1067a`). |
| **E8** | Dashboard + data | **Analyst feedback**: on the visit page, "confirm: human / agent X / script" and "false positive", stored in `visit_labels` (an audited, narrow `INSERT` grant for `admin_api_role`, the same pattern as detection acknowledgements). These count as ground truth *weaker* than signed lab runs, used for review queues and calibration checks, never for the release gate. | Lab runs cover agents we run ourselves. Real traffic is where unknown agents and real false positives show up. |
| **E9** | SDK | **Collector health beacon**: SDK version, per-module status counts (`{s}` from S2), total CPU ms and throws, sent once with `integrity`. Shown as an Overview metric ("SDK errors by browser"). | We'd otherwise only notice a browser update breaking a check when its signal quietly stops firing. |
| **E10** | Overview, alerts, live stream | (Extends W6.) Push "proven agent" and "AI agent reached checkout" onto the SSE live stream. Add Overview charts for the AI agent / automated / human split per day and top agents. Show the **visit verdict** on the AgentPanel of event detail pages (that panel exists today but only links to the visit). | Agent sensing becomes part of the SOC workflow instead of a separate page. |
| **E11** | Privacy | State in `PRIVACY.md` that `hp_visitor` lives 365 days and `hp_lab` 30 days. Consider shortening `hp_visitor` to match the 90-day telemetry retention. | Cookie lifetime longer than data retention is hard to justify. |

---

## 5. What we still don't take

Unchanged from `SDK_COMBINED_SUMMARY.md` §3: no Safari WebAuthn side channel, no hostname
rotation, no geolocation coordinates, no raw WebRTC IPs, no vendor code, keys, model or
endpoints, no heavy obfuscation, no typed values, and **no raw mouse paths for non-lab visitors**.

---

## 6. Phases

| Phase | Items | Why in this order | Size |
|---|---|---|---|
| **A. Foundations** | F1 fix (P4, A3, D6, L1), F2/F3 (R1, R2, R3, D5, A1, X10), F5 (S2 fallback removal, I2), F6 (D1), F8 (I4), **E2** (nginx beacon zone), **E6** (signal registry), **E7** (golden fixtures), A8 tests, O1–O4 + **E11** docs | Everything later depends on trusted labels, bound beacons, stored scores and a regression net. | 6–7 days |
| **B. Named agents and journey** | S1, S2, S3, I1 (probe kind), D2 (probe columns), I6 (probe part), X2, **E3** (journey signals), **E9** (SDK health), W1 (Probe badge), W2 (probes section), **E5** (timeline + grouped Why + counterfactual) | Highest precision for the least work. Journey signals use data we already store. The timeline makes every later signal reviewable. | 5–6 days |
| **C. Integrity, environment and network** | S4, S5, S6, P1, P2, I3, I6, D4, D8, X3, X5, X6, X9, A5, W2 (integrity/env), W4, **E1** (TLS/H2 profiles, RTT fusion) | Stealth automation and clustering. Plays to the server + page combination. | 6–7 days |
| **D. Human vs. agent input** | S7, S8, D3, X1, X4, **E4** (Stripe step), W1 (two scores), W2 (input physics) | The product's core claim: AI agent vs. bot vs. human. | 5–6 days |
| **E. Measurement and workflow** | L2–L7, A4, A6, D7, X8, W3, W5, W6, **E8** (analyst feedback), **E10** (overview, alerts, stream), D9, A7, O5 | Turns "we think" into "we measured", and brings agents into the SOC workflow. The gate goes live here. | 6–7 days |
| **Optional** | P3 + X7 (agent canary, if approved), WebRTC mismatch flag, Private Access Tokens | Need separate decisions. | — |

Total: about 28–33 working days for one engineer. That's more than the device plan's 13–17,
mainly because of Phase A, the input-physics and form-fill work from the gap analysis, and the
§4.11 additions (journey signals, network profiles, timeline UI, analyst feedback).

---

## 7. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Agent-readable canary (`/llms.txt` + hidden invitation) on uHoney? | **Yes, uHoney only**, neutral wording, reviewed before shipping. |
| D2 | Two scores (automated, AI agent) instead of one probability with a cap? | **Yes.** |
| D3 | Store scores (`visit_scores` + worker in the honeypot process) instead of scoring on read? | **Yes**, keeping on-read for the detail page. |
| D4 | Signed lab links, with unsigned `?lab=` downgraded to "claimed"? | **Yes.** |
| D5 | Raw mouse paths for authenticated lab runs only? | **Yes**, so the motion feature set can change later without re-running the lab. |
| D6 | Retention for new client tables: 90 days (as today) with a lab exception? | **90 days.** |
| D7 | Phase A (foundations) before any new SDK collection? | **Yes.** |
| D8 | Analyst feedback (`visit_labels`): a narrow, audited write grant for admin-api? | **Yes.** Same pattern as detection acknowledgements. |
| D9 | Build the browser TLS/H2 reference from our own human lab runs (no third-party JA4 database)? | **Yes.** It stays current with the browsers our visitors actually use. |
| D10 | Shorten `hp_visitor` from 365 to 90 days? | **Yes**, unless a cross-quarter returning-visitor analysis is needed. |
