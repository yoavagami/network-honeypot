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

## What we deliberately do not collect

- No browser fingerprinting beyond passive header/TLS observation (no canvas fingerprinting, no
  invasive client-side scripts).
- No tracking pixels, no third-party analytics, no ad-tech SDKs.
- No attempt to deanonymize visitors using external data broker lookups.
- No collection from client-side JS beyond what a normal production site would plausibly run (the
  deception requires *looking* like a real app, not *acting* like a surveillance one).

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
