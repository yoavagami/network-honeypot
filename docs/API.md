# Admin API

Base: internal/admin network only, never on the public Nginx vhost. All endpoints below except
`/api/auth/login` and `/api/system/health` require an authenticated admin session
(`admin_session` HttpOnly cookie) and, for state-changing requests, a matching CSRF token
(`X-CSRF-Token` header, double-submit against a non-HttpOnly `csrf_token` cookie).

Every authenticated request is written to `admin_audit_log`.

## Auth
```
POST   /api/auth/login          { username, password, totp? }  -> sets admin_session cookie
POST   /api/auth/logout
GET    /api/auth/me             -> current admin user (no password/mfa secret fields)
```
Rate-limited (Nginx + app-level) more aggressively than any public honeypot route. No public
registration endpoint exists in this API — admin users are provisioned via a host-run CLI script.

## Events
```
GET    /api/events              ?from&to&event_type&severity&actor_id&ip&path&method
                                 &status_code&q&cursor&limit(<=200)
GET    /api/events/:id          -> full event + linked request + actor summary + surrounding
                                    request/response context
```

## Actors
```
GET    /api/actors              ?from&to&min_risk&confidence&q&cursor&limit
GET    /api/actors/:id          -> profile: identity signals, counts, risk, first/last seen
GET    /api/actors/:id/timeline -> chronological event/request sequence for attack-path rendering
GET    /api/actors/:id/sessions
```

## Detections & Canaries
```
GET    /api/detections          ?from&to&type&acknowledged&actor_id
POST   /api/detections/:id/ack  -> marks acknowledged (audit-logged; admin_reader role has a
                                    narrow grant to write this one column set, nothing else)
GET    /api/canaries            -> registry of planted canaries + trigger counts
GET    /api/canaries/:id/events
```

## Analytics
```
GET    /api/analytics/overview   ?range=5m|1h|24h|7d|custom&from&to
   -> totals, requests/min, unique actors/IPs/UAs, methods, top endpoints, top attacked
      endpoints, error rate, auth attempts, scanner detections, enumeration attempts,
      canary triggers, ingestion health snapshot
GET    /api/analytics/traffic    ?range... -> time series for charts
GET    /api/analytics/attacks    ?range... -> detection-type breakdown, risk distribution
GET    /api/analytics/bots       ?range... -> classification distribution + confidence bands
GET    /api/analytics/first-contact             -> time-to-first-* metrics per actor cohort
```

## Search
```
GET    /api/search               ?q=<query>
```
Query grammar (subset, documented in-app): `field:value`, combined with `AND`/`OR`/`NOT` and
parentheses, e.g. `event_type:CANARY_TRIGGERED AND NOT country:US`. Parsed into a small AST server
side, translated to parameterized SQL — never string-concatenated.

## System
```
GET    /api/system/health        -> unauthenticated, minimal (ok/degraded + component booleans),
                                     no internal detail; the rich metrics from ARCHITECTURE §11
                                     live at /internal/metrics on the internal network only.
GET    /api/system/ingestion     -> events_received/processed/dropped/failed, queue depth,
                                     last_successful_flush_at (authenticated)
```

## Conventions
- Pagination: cursor-based (`cursor`/`limit`), never offset on the high-volume tables.
- Errors: `{ error: { code, message } }`, no stack traces, no internal identifiers beyond
  `request_id` for correlation with logs.
- All list endpoints validate query params against a zod schema; invalid params are a 400, not a
  silently-ignored filter.
