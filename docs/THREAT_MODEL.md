# Threat Model

## 1. Actors we expect to interact with the system

| Actor | Motivation | Sophistication | What we want to learn |
|---|---|---|---|
| Opportunistic scanners (mass Internet scanning: Shodan-style, Masscan+curl scripts) | Find *any* vulnerable/interesting host | Low | Baseline noise floor, which paths get hit blind |
| Vulnerability scanners (Nuclei, Nikto, ZAP, custom) | Fingerprint tech stack, find known CVEs | Low–Medium | Signature patterns, request shapes, timing |
| Credential attackers | Brute force / credential-stuff login, register, reset flows | Low–Medium | Username lists used, velocity, whether they adapt to lockouts |
| API attackers | Enumerate objects, IDOR, parameter tampering | Medium | ID enumeration patterns, whether they pivot from one found object to systematic sweep |
| Search/AI crawlers (Googlebot, GPTBot, ClaudeBot, CCBot, etc.) | Index content | N/A (benign) | Baseline "legitimate automation" to differentiate from attack traffic |
| Browser-automation / agentic tools (Playwright/Puppeteer/Selenium-driven, LLM-agent-driven) | Varies — could be benign research, could be an attack pipeline | Low–High | Whether navigation looks "reasoning-driven" vs scripted; distinguishing signal, not proof |
| Manual human attackers / researchers | Actually investigate the app, read responses, adapt | Medium–High | Full behavioral sequence; these are the highest-value sessions to review by hand |
| Curious humans / accidental visitors | None | N/A | Should be a small, low-noise share of traffic |
| Malicious insider (someone who discovers this *is* a honeypot and wants to poison it) | Discredit the data / waste analyst time | Varies | See §4 Data Integrity Threats |

## 2. What we are explicitly NOT defending

This system does not protect a real production asset — there is nothing "behind" it of real
value. The threat model is therefore not "prevent compromise" (compromise of the deceptive
surface is expected and fine) but:

1. **Prevent the compromise from spreading** beyond the honeypot app container.
2. **Prevent the telemetry from being corrupted or disabled**, since corrupted/missing telemetry
   is the actual loss condition for a honeypot.
3. **Prevent the honeypot from being used as a weapon** against anyone else.
4. **Prevent unnecessary collection** of real people's data (privacy harm is a real cost even on
   a deception system).

## 3. Attack surface inventory

| Surface | Exposure | Primary risk | Mitigation |
|---|---|---|---|
| Public HTTP(S) endpoints (all honeypot routes) | Internet | Expected/desired — this is the point | Sandboxed app, no real secrets, output encoding, no real DB write paths beyond telemetry + scoped synthetic state |
| File upload (if implemented) | Internet | Malicious file storage/execution, disk exhaustion | Size caps, stored with randomized names outside any served/executable path, never executed, type-sniffed not trusted from extension, quota per actor, virus-scan hook point documented (not required for POC since files are never served back or executed) |
| Login/register/reset forms | Internet | Credential stuffing infra, mass automation | Rate limiting, no real account takeover value (synthetic users only), never store raw passwords (hash immediately, and even the hash is of a *synthetic* credential with no reuse value) |
| Fake API | Internet | API-scanner fingerprinting, injection attempts against our own parsing | Input validated via schema at the edge; injection-shaped input is itself a detection signal, not something we try to "execute" |
| Admin dashboard | Internal/admin network, VPN-gated in production | Full telemetry visibility if compromised | Network isolation, strong auth, CSRF, audit log, MFA-ready, never on the public vhost |
| Nginx | Internet (TCP 80/443 only) | DoS, request smuggling, TLS misconfig | Conservative buffer/timeout config, HTTP/1.1+HTTP/2 only with strict parsing, TLS config per Mozilla "intermediate" baseline, no legacy protocol support |
| PostgreSQL | Internal network only, never published | Data exfiltration/tamper if reached | No public port, scoped roles per service, honeypot role cannot read admin tables or other actors' full raw IP beyond its own writes |
| Container runtime | Host | Container escape | No Docker socket mount, no host mounts beyond named volumes for Postgres data, non-root users, dropped capabilities, read-only root fs on app containers |
| Secrets (.env, signing keys, DB creds) | Deployment host | Credential theft feeding lateral movement | Never baked into images, never logged, never in the DB, unique per-service, rotatable independently |

## 4. Specific attacker questions we design against (from §43 of the brief)

Each is answered with the concrete control, not just a promise:

1. **Identify the honeypot?** — We accept this is possible with enough effort (response timing
   uniformity, absence of certain real-world quirks). We do not claim undetectability; we aim for
   "not trivially obvious," and we still get value from an attacker who probes carefully, since
   *how* they probe is itself data.
2. **Identify the framework?** — Server header genericized, stack traces never returned, error
   pages are our own realistic templates, not framework defaults.
3. **Bypass logging?** — Logging happens in Nginx (outside app control) and in a Fastify
   `onRequest`/`onResponse` hook pair that runs for *every* route including 404s, unmatched
   methods, and framework-level errors — there's no code path that reaches a response without
   passing through it.
4. **Cause events to be dropped?** — Possible only via genuine capacity exhaustion, and that
   condition is itself alertable (`events_dropped_total`) rather than silent.
5. **Overwhelm the database?** — Batched writes + bounded queue + Nginx rate/connection limits;
   worst case degrades to counts-only mode rather than falling over (ARCHITECTURE.md §12).
6. **Reach the admin dashboard?** — Different container, different network, different port;
   Phase 4 adds a network-level access gate in front of it.
7. **Access telemetry infrastructure?** — Postgres has no public port; only the honeypot app
   (write-scoped) and admin-api (read-scoped) can reach it, both over the internal Docker network.
8. **Escape the container?** — Non-root, read-only root fs, dropped Linux capabilities, no
   sensitive mounts, no Docker socket; kept current on base image patches.
9. **Obtain environment variables?** — App never echoes env, never renders it into any response
   (including error pages), and secrets aren't logged. A code-execution-level compromise inside
   the container could still read its own env — that's why the honeypot app's env contains
   *nothing* of value beyond its own scoped, rotatable DB credential.
10. **Access cloud credentials?** — None are ever placed on the honeypot host. If deployed to a
    cloud VM, no IAM role/instance-metadata credentials are attached to the honeypot's compute
    identity (documented requirement in DEPLOYMENT.md checklist).
11. **SSRF to internal systems?** — The honeypot app makes zero outbound calls to attacker-influenced
    URLs; it doesn't fetch, proxy, or render remote resources on request. Any future "enrichment"
    calls (GeoIP lookups) are keyed by *our* extracted IP, never by attacker-supplied URLs, and run
    from a context with no internal-network reachability beyond Postgres.
12. **Make the honeypot attack another system?** — No outbound-request capability exists in the
    honeypot app's route handlers at all (see §27 of the brief — enforced structurally, not just by
    policy: the app has no HTTP client dependency wired into any public route handler).
13. **Poison actor correlation?** — An attacker can certainly cause noisy correlation (e.g. cycle
    IPs/UAs) — that's expected and why confidence levels exist rather than hard identity claims.
    What they cannot do is overwrite another actor's history, since correlation keys are
    server-derived, not client-supplied.
14. **Spoof headers?** — Headers are recorded as observed, but IP-based logic never trusts
    client-supplied forwarding headers (ARCHITECTURE.md §9); UA is recorded verbatim but never
    treated as identity proof.
15. **Evade detection?** — Assumed to be possible for a sophisticated actor against any single
    rule; the detection engine is designed to layer multiple weak signals (DETECTION.md) rather
    than rely on one, and every raw event is retained regardless of whether a rule fired, so
    detection logic can be improved retroactively over stored history within the retention window.
16. **Inject fake events?** — There is no code path from a public request directly into the events
    table; the app constructs event objects server-side from its own observations, and the
    admin-api's DB role cannot write to `events`/`requests` at all.
17. **Manipulate timestamps?** — All event timestamps are assigned server-side (`now()` at
    capture time / DB `DEFAULT now()`), never accepted from client input.
18. **Cause excessive storage consumption?** — Per-body size caps, no verbatim body storage,
    retention + partition-drop jobs, and a disk-guard fallback to counts-only mode.

## 5. Data integrity threats specific to a honeypot (not in the original checklist, added here)

- **Analyst time-wasting via garbage floods**: mitigated by risk scoring and detection tagging
  rather than expecting a human to read every row; the dashboard is built around
  aggregation/search, not "scroll the table."
- **False attribution**: never present actor correlation or bot classification as certain fact —
  every such label ships with a confidence value and the signals behind it, everywhere in the UI
  and API, not just in one place.

## 6. Out of scope (explicitly, per the brief's "no active attacking" requirement)

We will not implement, even as an option: retaliatory scanning, exploitation of visiting clients,
malware/payload delivery, credential theft from visitors, drive-by content, outbound port scanning
of visitor IPs, or any code path that issues a request to an address derived from attacker input.
