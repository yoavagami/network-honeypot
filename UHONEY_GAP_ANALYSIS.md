# uHoney: what we have, what's missing, and the end-to-end proposal

Status (2026-11-13): **Phase 0 and the rendering ladder shipped** (commits ecffa96, 0bcd3dd, bb1067a, b9c3c97); hybrid agent/human control shipped in 2067ec7. The rest is superseded by `SDK_V2_IMPLEMENTATION_PLAN.md`, which tracks what's left.

Inputs:
- the code on `feat/agent-sensing`;
- `SDK_COMBINED_SUMMARY.md`;
- `DEVICE_SDK_UPGRADE_PLAN.md`, the implementation plan this document refines.

---

## 1. Summary

uHoney already does something neither vendor SDK does: it combines **what the server sees**
(TLS/HTTP2 fingerprint, header order, Web Bot Auth signatures, published agent IP ranges, data-centre
origin) with **what the page sees** (fingerprint, automation markers, agent DOM markers, behaviour)
and **what the shopper does** (the shop funnel, through to a Stripe test payment). That combination
is the right base.

The gaps are in four places:

| # | Gap | Why it matters |
|---|---|---|
| **G1** | **We collect far more than we use.** About 60% of the page-script fields (fonts, audio, voices, battery, devices, client hints, click offsets, key types, pastes…) never reach the score or the dashboard. | Free accuracy, already being paid for in collection. |
| **G2** | **Server and page are never cross-checked.** The edge checks itself (UA vs. TLS, client hints vs. UA), and the page checks itself. Nothing asks "does the page agree with the connection?" (timezone vs. IP country, JS languages vs. `Accept-Language`, JS UA vs. header UA, JS engine vs. TLS stack). | This is where stealth tools and cloud agents break. They patch one layer, rarely all of them. It's our natural edge. |
| **G3** | **We catch automation, but can't yet say "AI agent" for unnamed agents.** The scorer caps at "not sure" without AI-specific evidence, and AI-specific evidence today is mostly identity (signatures, IP lists, UA claims, two DOM markers). | Merchants need *AI agent* vs. *bot* vs. *human*: different business decisions. Agents that drive a screen (Claude in Chrome, ChatGPT agent, Operator-style tools) have a **behavioural signature** we don't measure yet: think-pause, then act. |
| **G4** | **There's no measurement loop.** Weights are guesses (`calibrated: false`), there's no lab-coverage view, no false-positive baseline from real humans, and no stable device clustering. | Without it we can't claim accuracy to a merchant or an investor, or know which signal to build next. |

**The proposal:** close G1–G4 in five phases (§6). The end state:
- every visit gets **three independent answers**: *who is it*, *is a human driving*, and *is the
  environment real*;
- each answer comes with evidence a merchant can read;
- there's a **measured** accuracy per agent type.

---

## 2. What uHoney has today (inventory)

Legend:
- **C** = collected;
- **S** = used by the score (`packages/detection/src/agentScore.ts`);
- **D** = shown on the dashboard (`AgentVisitPage` / `AgentsPage`).

### 2.1 Server side, per request (`apps/honeypot/src/sensing/*`, `src/edge/*`, table `request_signals`)

| Capability | C | S | D | Notes |
|---|---|---|---|---|
| TLS ClientHello → JA4, JA3n, GREASE, ALPN (edge sensor) | ✓ | ✓ | ✓ | Through `tls_mismatch`. |
| HTTP/2 SETTINGS / pseudo-header order fingerprint | ✓ | ✓ | ✓ | `h2_pseudo_order_not_chromium`. |
| Header order hash and values (secrets redacted) | ✓ | partial | ✓ | Order hash isn't used for clustering. |
| Header consistency (client hints, sec-fetch, accept-*) | ✓ | ✓ | ✓ | 10 flags. |
| UA parse → claimed agent, automation library, AI app | ✓ | ✓ | ✓ | |
| **Web Bot Auth** signature verification | ✓ | ✓ proof | ✓ | |
| Published AI-operator IP ranges, rDNS, Tor | ✓ | ✓ | ✓ | |
| ASN / infra class (cloud, VPS, residential, proxy) | ✓ | ✓ | ✓ | |
| Identity verdict (verified/spoofed/claimed/automation/browser) | ✓ | ✓ | ✓ | |
| Probing paths (.env, wp-config…) | ✓ | ✓ | ✓ | |
| Lab label `?lab=` → `hp_lab` | ✓ | — | ✓ | Shown, but not used for evaluation. |

### 2.2 Page script (`apps/honeypot/static/app.js`, table `client_signals`, kinds `fp` and `behavior`)

| Capability | C | S | D |
|---|---|---|---|
| `navigator.webdriver`, webdriver getter tamper, own property | ✓ | ✓ | ✓ |
| Automation globals (33 names) + window/document regex scan | ✓ | ✓ | ✓ |
| CDP-attached trick (Error stack getter via `console.debug`) | ✓ | ✓ | ✓ |
| `Function.prototype.toString` native check (1 function) | ✓ | — | ✓ |
| Injected globals vs. clean iframe (`globalsDiff`) | ✓ | ✓ | ✓ |
| Agent DOM markers (Claude in Chrome, Comet) + MutationObserver + agent-word regex | ✓ | ✓ proof | ✓ |
| WebGL vendor/renderer (software-GPU check) | ✓ | ✓ | ✓ |
| Outer window 0×0 | ✓ | ✓ | ✓ |
| Canvas hash, audio hash, font list (30) | ✓ | **—** | partial |
| Screen, DPR, viewport, media queries | ✓ | **—** | partial |
| Intl: timezone, locale, offset | ✓ | **—** | partial |
| `userAgentData` high-entropy values | ✓ | **—** | partial |
| Battery, connection, storage quota, media devices, permissions, voices count | ✓ | **—** | partial |
| `chrome.*` object shape, plugins, mimeTypes, `historyLength` | ✓ | **—** | partial |
| Navigation timing (protocol, TTFB) | ✓ | **—** | — |
| Mouse: moves, distance, max speed, untrusted moves | ✓ | ✓ (`human_mouse`) | ✓ |
| Clicks: trusted, had mousedown, moves in the last 1 s, **offset from the target centre (`dx`/`dy`)**, zero coordinates, pointer type | ✓ | partial (trusted, press, teleport) | ✓ |
| Keys: count, untrusted, intervals, **key types**, input without key | ✓ | partial (rhythm, input without key) | ✓ |
| Paste, copy, selection, context menu, wheel, touch, scroll, focus/blur, visibility | ✓ | partial (wheel, touch, hidden-driven) | ✓ |

### 2.3 Journey (shop events)

| Capability | C | S | D |
|---|---|---|---|
| 21 `SHOP_*` events (view → cart → checkout → payment → order) | ✓ | partial | ✓ |
| Fast navigation, instant checkout | ✓ | ✓ | ✓ |
| Stripe test PaymentIntent outcome | ✓ | — | partial |

### 2.4 Scoring, data and dashboard

| Capability | Today |
|---|---|
| Score | Log-odds sum, prior −1.2, about 30 signals, proof shortcuts, "no AI evidence" cap at 0.69. Uses only `fps[0]` (the first page load). |
| Identity across visits | The `hp_visitor` cookie (365 days) plus actor correlation. **No device-level ID** when cookies are cleared. |
| Storage | Raw JSON in `client_signals.data`. Nothing derived or indexed per page load. |
| Dashboard | Agents list (P(AI), type, top reasons), visit page (Why, Network, Browser, Behavior, Shop, Requests). |
| Evaluation | None: no coverage matrix, no human baseline, no calibration. |

---

## 3. What's missing, by the question it answers

### Q1: "Which agent is this?" (named identification)

| Missing | Today | Suggested | How |
|---|---|---|---|
| Agents that **read** the DOM without injecting UI | Only Claude in Chrome and Comet markers | Decoy-field trap that notices a DOM-scanner reading it (browser-use style) | An invisible, `aria-hidden`, non-focusable input whose attribute reads are watched. It records *who* reads it from the call stack, then removes itself. |
| Extension-based agents that answer messages | — | A `postMessage` handshake probe (Manus style) | Post a known ping to our own window and listen for an agent's answer. |
| Framework globals | 33 names | Full list: Magnitude, Skyvern (5-function set), Stagehand `__stagehandInjected`, ChromeDriver name regex, CEF/Awesomium/Nightmare… | Extend `automation()` and poll for 10 s, because some inject late. |
| Agent UI CSS | — | Comet `--sidecar-*` variables, all `pplx-agent-*` ids | `getComputedStyle(documentElement)`. |
| **Agents that run no JavaScript** (fetchers, LLM browse tools) | Only `no_javascript` / `no_subresources` (≥2 pages) | **(new) Rendering ladder**: tell apart "fetched HTML only" / "rendered CSS, no JS" / "ran JS" from one page | 1) a CSS-only beacon (`background-image` on a hidden element pointing at a unique URL); 2) a `<noscript>` image; 3) the JS beacon. Which of the three arrive per page load places the client on the ladder, even after one page. |
| **(new) Agent-readable canary** | — | A visible-to-machines, invisible-to-humans note in the page and in `/llms.txt` that invites *AI assistants* to open a harmless page, `/agents/hello?ref=<page-load id>` | Only an LLM that reads and follows page text will open it. **It's AI-specific evidence even for no-JS fetchers.** Kept harmless: no instructions that change the user's task, no data requests. See the decision point in §8. |

### Q2: "Is a human driving the input?"

| Missing | Today | Suggested | How |
|---|---|---|---|
| **(new) Action cadence: "think, then act"** | — | Screen-driving AI agents show **bursts of action separated by 2–15 s pauses with a perfectly still cursor** (the model is "thinking" on a screenshot). Humans move while thinking; classic bots don't pause. | From the behaviour stream: idle gaps with 0 moves, followed by a click within under 300 ms of the first move. The output is `think_pauses`, `still_ratio`, `burst_count`. |
| **(new) Dead-centre clicks** | `dx`/`dy` already collected, **unused** | Agents click the exact centre of the element's bounding box (coordinates come from the accessibility tree or screenshot boxes). Human clicks spread. | Score from the `dx`/`dy` spread: tight clustering near 0 over ≥ 3 clicks = synthetic. |
| **(new) Fixed-step scrolling** | Scroll count only | Agents scroll by fixed pixel steps (e.g. exactly one viewport or 3×100 px) at even intervals | Record `scrollY` deltas and the times between them; look at the spread. |
| Coalesced events, `pointerrawupdate` | — | Real high-rate mice batch samples; CDP-injected moves don't | `getCoalescedEvents().length` histogram. |
| `movementX/Y` vs. `clientX/Y` consistency | — | DevTools-injected moves often report `movementX/Y = 0` while the position changes, or `screenX − clientX` stays inconsistent | Count the mismatches per 100 moves. |
| Pointer pressure / type plausibility | Only `pointerType` on clicks | Mouse pressure 0.5 when pressed, 0 otherwise; constant or impossible values = synthetic | Stats per pointer type. |
| Mouse timing statistics | Max speed only | Interval mean/sd/percentiles, drop ratio, jitter, longest evenly spaced run | Rolling buffer of the last 200 timestamps. |
| Trajectory shape | Distance only | Curvature, straight-line deviation, acceleration and jerk profile, overshoot before a click | Features per 50-sample packet. **No raw paths stored.** |
| **(new) Form-fill sequence** | Input-without-key, field types | Humans tab or click into fields, sometimes go back, and autofill (password managers, browser autofill fire `:autofill` / `animationstart` tricks). Agents fill in DOM order, with no focus moves, and paste-like whole values. | Field focus order, focus method (click, Tab, programmatic), time per field, autofill detected, corrections (Backspace count). **Never the values.** |
| Key types | Collected, unused | All-printable typing with no corrections and no modifiers over 30+ keys = scripted | Use the existing `keyKinds`. |

### Q3: "Is the environment real and consistent?"

| Missing | Today | Suggested | How |
|---|---|---|---|
| **(new) Server ↔ page cross-checks (G2)** | — | Timezone vs. IP country; `navigator.languages` vs. `Accept-Language`; JS UA vs. header UA; `userAgentData` vs. `Sec-CH-UA`; JS engine features vs. the TLS family; `navigator.platform` vs. the TLS/H2 OS hints | A server-side join of `client_signals` and `request_signals` per page load, in a new `fusion.ts`. Every mismatch becomes a named flag. |
| Page vs. iframe vs. worker | Globals diff only | Compare navigator/screen in a fresh iframe; WebGL renderer in a Worker vs. the page | One iframe (already created for `globalsDiff`) and one tiny Worker. |
| Wider native-function check | 1 function | About 40 commonly patched APIs; getter-on-instance checks | Loop with `toString` and descriptor checks. |
| Engine vs. claimed browser | Header level only | Feature-implied engine (Chrome, Safari, Firefox, Brave, Edge) vs. UA | Feature presence table. |
| Headless tells | Software GPU, WebGL missing | DRM key systems (Widevine missing on "Chrome"), WebGPU fallback adapter, missing-feature count, media-device count 0, voices 0, battery 100%/∞ | Mostly data we already collect (voices, battery, devices) plus EME and WebGPU. |
| Canvas tampering | Hash only | A server-verified seeded pixel grid → `noise` / `clean` | Seed derived by HMAC from the page's request ID. |
| Beacon forgery | — | The HMAC seed doubles as proof that the beacon belongs to the page we served; plus plausibility checks | See `DEVICE_SDK_UPGRADE_PLAN.md` §2. |

### Q4: "Have we seen this one before?" (clustering, not tracking)

| Missing | Today | Suggested |
|---|---|---|
| Device/environment cluster key | — | `env_hash` (engine, OS, GPU class, fonts, voices, codecs, screen class) and `device_hash` (adds canvas and audio). It groups "the same cloud-browser image" across IPs and cookie resets, **on uHoney only**. |
| Network cluster key | JA4 and header-order hash stored separately | `net_hash` = JA4 + H2 fingerprint + header-order hash. Shows the same agent stack behind rotating IPs. |
| Known-cluster memory | — | When a cluster is proven or lab-labelled once, later visits from it inherit a `known_cluster` signal. |

### Q5: "How good are we?" (measurement, G4)

| Missing | Suggested |
|---|---|
| Lab-coverage matrix | Lab run × signal grid, plus the final bucket per run. |
| Human baseline | `human-<browser>-<n>` runs by us (desktop and mobile) as the false-positive gate. |
| Calibration | Fit the weights (logistic regression) on lab labels; show a reliability chart; switch `calibrated` to true per model version. |
| Model registry | `detection_models` with metrics and a superadmin-only, audited activation. |
| (new) Stripe cross-check | In test mode, record Stripe's own Radar risk level on the PaymentIntent's charge next to our verdict. It's an outside view to compare against. |

---

## 4. The end-to-end experience: before vs. after

The same four visitors in each table.

### 4.1 Claude in Chrome on the user's own laptop

| Step | Today | After |
|---|---|---|
| Network | Residential IP, real Chrome TLS → looks human (−0.7) | Same |
| Page script | Claude's DOM marker → **proven** | Same proof, **plus** independent evidence: think-pause cadence, dead-centre clicks, form filled in DOM order, so detection survives if the marker changes |
| Dashboard | "AI agent, proven (DOM marker)" | Probe, Input and Env badges; a cadence timeline; "would still be caught without the marker: yes (P = 0.93)" |

### 4.2 ChatGPT agent / a cloud browser agent

| Step | Today | After |
|---|---|---|
| Network | Published IP range or data-centre IP → strong | Same, plus `net_hash` cluster |
| Page script | Maybe a software GPU; otherwise little | VM/headless tells (DRM, WebGPU, devices, voices); timezone ≠ IP country; think-pause cadence |
| Type | `cloud_browser_agent` | Same, with an explicit "screen-driving AI" reason, not just "automated + data centre" |

### 4.3 A stealth Playwright bot (not an AI)

| Step | Today | After |
|---|---|---|
| Network | Often clean Chrome TLS | Same |
| Page script | Stealth plugins hide `webdriver`; maybe the CDP trick | Iframe/worker lies, native-function lies, DRM missing, coalesced events missing, movement inconsistencies |
| Verdict | Often "not sure" | **"Automated, not an AI agent"**. That matters, because merchants treat scalpers and fraud bots differently from shopping agents. |

### 4.4 An LLM fetch tool (no JavaScript)

| Step | Today | After |
|---|---|---|
| One page | Nothing until ≥ 2 pages | The rendering ladder says "HTML only" on the first page |
| AI or script? | Capped at "not sure" without a UA claim | Opening the agent-readable canary = **AI-specific** evidence (if approved, §8) |

### 4.5 A real human shopper (must stay clean)

| Step | Today | After |
|---|---|---|
| Evidence for "human" | Mouse distance, wheel, touch, typing rhythm | Plus coalesced samples, natural jitter, click spread, autofill, corrections, movement while reading → **stronger "human" evidence**, so fewer false "not sure" verdicts |
| Gate | None | Human control runs are a release gate (≤ 2% false positives) |

---

## 5. What changes, layer by layer

| Layer | Change | Where |
|---|---|---|
| **Page script** | Versioned SDK v2 built from modules. New kinds: `probe`, `integrity`, `motion`. Extended `behavior` (cadence, click spread, scroll steps, coalesced events, movement consistency, form-fill sequence). Rendering ladder (CSS + noscript beacons). | `apps/honeypot/sdk/src/*` → `static/app.js` |
| **Pages** | Canvas seed `<meta>`; CSS/noscript ladder beacons in `render/layout.ts` and `shop/render.ts`; optional agent canary text and `/llms.txt`. | `apps/honeypot/src/render`, `src/shop`, `src/routes/misc.ts` |
| **Ingestion** | Schema validation, per-kind caps, seed check, **fusion** (server ↔ page cross-checks), derived profile per page load. | `src/routes/rum.ts`, new `src/sensing/client/{schema,canvasSeed,derive,fusion}.ts` |
| **Database** | Migration 0012: `client_signals` +`schema_version`/`sdk_version`/`tab_id`; new `device_profiles`, `motion_packets`, `detection_models`, view `device_clusters`; `request_signals` +`net_hash`; Stripe Radar level on payment events. | `packages/db/migrations/0012_*.sql` |
| **Scoring** | Uses every page load (not just `fps[0]`). New signals: probes, rendering ladder, canary, fusion mismatches, lies, headless/VM, cadence, centre clicks, scroll steps, synthetic input, human input, motion model, known cluster. A second output, `automation_score`, so "bot" and "AI agent" are separate. Calibrated weights per model version. | `packages/detection/src/agentScore.ts` (+ `fusion` types) |
| **Admin API** | Visit detail gets profiles and fusion; new `/api/devices`, `/api/lab/coverage`, `/api/models`. | `apps/admin-api/src/routes/{agents,devices,lab,models}.ts` |
| **Dashboard** | Agents list: Probe, Env and Input badges, filters, and separate "AI agent" and "Automated" columns. Visit page: Agent probes, Consistency (server ↔ page), Environment, Input physics (cadence timeline, click-spread plot), Rendering ladder. New pages: Devices, Lab coverage, Model. | `apps/admin-web/src/pages/*` |
| **Lab** | Naming convention, run matrix (agents + humans), training and report scripts, release gate. | `scripts/train-motion-model.ts`, `scripts/lab-report.ts` |

---

## 6. Suggested order

| Phase | What | Why first | Size |
|---|---|---|---|
| **0. Use what we have** | Score and show the unused fields: click centre spread, key types, voices/devices/battery for VM detection, timezone vs. IP country, JS UA vs. header UA, all page loads instead of `fps[0]`. No new collection. | Fastest accuracy gain; tells us quickly which new data is worth collecting. | 1–2 days |
| **1. Named agents + rendering ladder** | Probes (decoy field, handshake, globals, CSS), CSS/noscript ladder, `probe` kind, `device_profiles` (first columns). | Highest-precision signals; covers no-JS agents from the first page. | 2–3 days |
| **2. Fusion + integrity** | `fusion.ts`, iframe/worker/native lies, DRM/WebGPU, canvas seed, `net_hash`/`env_hash`, Devices page. | Plays to our unique strength (server + page). | 4–5 days |
| **3. Human-vs-agent input** | Cadence, scroll steps, coalesced events, movement consistency, form-fill sequence, motion features, Input physics UI. | Separates *AI agent* from *bot* from *human*: the product's core claim. | 4–5 days |
| **4. Measurement loop** | Lab matrix, human baseline, coverage page, calibration, motion model, model page, Stripe Radar comparison. | Turns "we think" into "we measured". Needed for merchants and investors. | 4–5 days |

Phase 0 goes first because it costs nothing in collection and privacy, and it tests the scoring
changes before the SDK grows.

---

## 7. Why this is important (beyond the honeypot)

1. **Product fit.** "Agent Traffic & Checkout Insights" needs exactly three outputs per session:
   AI agent / bot / human, which agent, and how sure. Today we have the first part for proven
   cases only.
2. **Precision over recall.** Merchants will accept agents, and some will want them. A wrong "bot"
   label on a real shopper is the costly mistake. More *human* evidence (Phase 0/3) and a measured
   false-positive rate (Phase 4) protect against it.
3. **Robust to change.** DOM markers and UA strings change with every agent release. Behaviour
   (think-pause cadence, centre clicks, form-fill order) and consistency checks (server ↔ page)
   are much harder for agent makers to change, and they generalise to agents we haven't seen.
4. **Our moat.** The vendors either live in the page (Forter) or mostly fingerprint devices
   (Fingerprint). Combining edge, page and journey is what we can sell, and the fusion layer is
   where it shows most.
5. **Transferable.** The SDK v2 module layout and the derived `device_profiles` schema are what a
   merchant-side integration (Shopify app / SDK + our endpoint) would ship, so the honeypot work
   becomes the product's first version.

---

## 8. Decisions for the review

1. **Agent-readable canary (§3 Q1).** It's strong AI-specific evidence, including for agents that
   run no JS. It's harmless if worded as a neutral invitation, and it's established practice in
   LLM-honeypot research. Do we want it on uHoney? Recommended: **yes, on uHoney only**. It would
   not be part of the merchant product without the merchant's explicit opt-in.
2. **Separate "automated" and "AI agent" scores** in the UI, or keep one probability with a type?
   Recommended: **two scores**.
3. **Phase 0 before the SDK work?** Recommended: **yes**.
4. **Motion model:** train our own from Phase 4. Until then, heuristics only. Recommended: **yes**.
5. **WebRTC IP check / Private Access Tokens:** park both. Recommended: **park**.
6. **Retention:** 180 days for unlabelled raw client data; lab-labelled data kept. Confirm.

---

## 9. Kept out (unchanged from the summary)

- Cross-site tracking techniques (the Safari WebAuthn channel).
- Hostname rotation to get past blockers.
- Geolocation coordinates; raw WebRTC IPs.
- Typed values, or raw mouse paths.
- Any vendor code, keys, model or endpoint.
