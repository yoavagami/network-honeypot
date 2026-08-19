# Data Model

## 1. Design principles

- Structured columns for everything we filter/aggregate/index on; JSONB only for genuinely
  variable-shape data (raw header allowlist, extra detection metadata).
- High-volume tables (`requests`, `events`) are designed for time-based partitioning from day
  one, even though Phase 1 may run a single partition — adding partitions later is a schema-
  compatible operation, not a migration that touches application code.
- Every table that stores anything derived from a visitor carries enough structure to support
  redaction/retention jobs (a `created_at`, and for IP-bearing rows, the hashed form is the
  primary key, not the raw form).
- No table stores raw passwords, ever — not even for the synthetic honeypot users (their
  passwords are hashed with Argon2id like any real system would, both because it's the realistic
  behavior we want to model and because it's simply correct practice).

## 2. Core tables

### `actors`
Probabilistic identity cluster (see ARCHITECTURE.md §7).
```
actor_id            uuid PK
first_seen_at        timestamptz
last_seen_at         timestamptz
confidence           text          -- 'low' | 'medium' | 'high'
risk_score           int           -- 0-100, recomputed by detection worker
total_requests       bigint
unique_paths         int
label                text          -- optional analyst-set label
notes                text          -- optional analyst notes
```

### `actor_signals`
Append-only signal history feeding correlation (one actor has many).
```
id                   bigserial PK
actor_id             uuid FK -> actors
signal_type          text    -- 'ip_hash' | 'ua_fingerprint' | 'visitor_id' | 'tls_tuple'
signal_value         text
first_seen_at        timestamptz
last_seen_at         timestamptz
occurrence_count     int
UNIQUE (actor_id, signal_type, signal_value)
```

### `sessions`
```
session_id           uuid PK
actor_id             uuid FK -> actors
visitor_id           uuid          -- cookie-backed, pre-auth identity
created_at           timestamptz
last_seen_at         timestamptz
ip_hash              text
user_agent_raw       text
user_agent_fingerprint text
authenticated_as     text NULL     -- synthetic username if they "logged in", never real creds
```

### `requests`  (partitioned by `created_at`, monthly)
The raw normalized HTTP event — one row per inbound request.
```
request_id           uuid PK (includes partition key via composite PK (request_id, created_at))
created_at            timestamptz NOT NULL
actor_id              uuid FK -> actors
session_id            uuid FK -> sessions NULL
ip_hash               text NOT NULL
ip_raw                inet NULL        -- NULL'd out by retention job after RAW_IP_RETENTION_DAYS
source_port           int
method                text
scheme                text
host                  text
path                  text
query_string          text NULL         -- redacted per packages/detection redaction rules
http_version           text
status_code            int
request_bytes           int
response_bytes           int
duration_ms              numeric
user_agent_raw            text
user_agent_fingerprint    text
referer                    text
origin                      text
accept                       text
accept_language                text
accept_encoding                  text
content_type                       text
forwarded_for_client_supplied        text NULL   -- explicitly labeled untrusted, see ARCHITECTURE §9
tls_version                            text NULL
tls_cipher                              text NULL
alpn                                     text NULL
endpoint                                  text    -- logical route name, e.g. "api.users.get"
application_component                       text
risk_score                                    int
INDEXES: (actor_id, created_at), (path), (status_code), (created_at), (ip_hash, created_at)
```

### `events`  (partitioned by `created_at`, monthly)
Higher-level, richer than a raw request row — this is what the detection engine emits, and what
the dashboard's live stream/search primarily reads. A single request can produce multiple events
(e.g. `HTTP_REQUEST` + `PATH_ENUMERATION` + `SCANNER_DETECTED`).
```
event_id              uuid PK (composite PK w/ created_at for partitioning)
created_at             timestamptz NOT NULL
request_id              uuid NULL        -- FK -> requests, NULL for actor-level correlation events
actor_id                 uuid FK -> actors
session_id                 uuid NULL
event_type                  text NOT NULL  -- from the taxonomy, see DETECTION.md
severity                      text          -- 'info' | 'low' | 'medium' | 'high' | 'critical'
risk_score                     int
source                           text        -- 'inline_rule' | 'correlation_worker' | 'canary'
metadata                          jsonb       -- structured, rule-specific detail (never raw body)
INDEXES: (event_type, created_at), (actor_id, created_at), (severity, created_at)
```

### `detections`
A materialized "this rule fired for this actor at this time" record, distinct from the raw event
stream so the dashboard can show "detections" (things we're confident matter) separately from
"events" (everything).
```
detection_id           uuid PK
actor_id                 uuid FK -> actors
detection_type              text   -- 'reconnaissance' | 'enumeration' | 'fuzzing' | 'scanner'
                                     -- | 'auth_probing' | 'api_probing' | 'bot_classification'
confidence                    numeric  -- 0.0-1.0
evidence                        jsonb  -- signals that contributed
first_event_at                    timestamptz
last_event_at                       timestamptz
event_count                           int
acknowledged                            boolean DEFAULT false
acknowledged_by                           text NULL   -- admin_users.username
acknowledged_at                             timestamptz NULL
```

### `canary_objects`
The registry of every synthetic secret/URL/ID planted in the app.
```
canary_id              uuid PK
canary_type              text   -- 'api_key' | 'internal_url' | 'credential' | 'token' | 'object_id'
value                      text  -- the actual synthetic value embedded (never valid anywhere real)
planted_location            text  -- where in the app this appears, e.g. "GET /api/v1/config"
created_at                    timestamptz
active                           boolean DEFAULT true
```

### `canary_events`
```
canary_event_id          uuid PK
canary_id                  uuid FK -> canary_objects
actor_id                     uuid FK -> actors
request_id                     uuid FK -> requests
created_at                       timestamptz
usage_context                      text  -- e.g. 'sent_as_bearer_token', 'used_as_object_id'
```

### `synthetic_objects`
Seeded fake data actually served by the honeypot app (users, orgs, documents, invoices, API keys
shown in "profile" pages) — kept separate from real app logic so it's obvious nothing here is real.
```
object_id                uuid PK
object_type                 text  -- 'user' | 'organization' | 'document' | 'invoice' | 'api_key'
public_ref                    text  -- the ID exposed in URLs (often small sequential int-looking)
data                             jsonb  -- the fake record content
created_at                         timestamptz
```

### `admin_users`
```
admin_user_id             uuid PK
username                     text UNIQUE
password_hash                  text   -- Argon2id
mfa_secret                       text NULL   -- TOTP secret, MFA-ready architecture
created_at                         timestamptz
last_login_at                        timestamptz NULL
disabled                               boolean DEFAULT false
```
No public registration endpoint exists anywhere in the codebase for this table — rows are only
ever created by a CLI seed/admin-create script run on the host.

### `admin_audit_log`
```
audit_id                  bigserial PK
admin_user_id                uuid FK -> admin_users
created_at                     timestamptz
action                           text   -- 'login' | 'view_actor' | 'ack_detection' | 'search' | ...
target                              text NULL
ip_hash                              text
metadata                              jsonb
```

## 3. Partitioning strategy

`requests` and `events` are Postgres native range-partitioned tables, partitioned by
`created_at` (monthly). Phase 1 creates the current + next month's partition at migration time and
a scheduled job (documented in OPERATIONS, built in Phase 3) creates future partitions and drops
partitions older than the retention window — dropping a partition is O(1) and avoids the
`DELETE`-on-huge-table problem entirely. This is designed in Phase 1 (the schema is partitioned
from the first migration) even though automatic partition management is a Phase 3 item — running
Phase 1 at modest volume with 1-2 manually-created partitions is fine.

## 4. Retention & redaction

Configurable via environment (defaults shown):
```
RAW_IP_RETENTION_DAYS=7          # after this, requests.ip_raw is NULL'd (ip_hash retained)
EVENT_RETENTION_DAYS=90          # after this, events/requests partitions are dropped
REQUEST_BODY_RETENTION=false     # bodies are never stored verbatim regardless; this only
                                  # controls whether the redacted key-shape summary is kept
USER_AGENT_RETENTION_DAYS=90     # aligned with event retention by default
GEOLOCATION_ENABLED=false        # Phase 1 default off; enrichment is opt-in (see ARCHITECTURE §Phase 2)
```
A daily cleanup job (cron in Phase 1, can run as a one-off script; automated in Phase 3):
1. NULLs `requests.ip_raw` for rows older than `RAW_IP_RETENTION_DAYS`.
2. Drops `requests`/`events` partitions entirely older than `EVENT_RETENTION_DAYS`.
3. Leaves `actors`/`detections`/`admin_audit_log` on their own longer retention (1 year default,
   since these are aggregated/low-cardinality relative to raw events and are the actual long-term
   research value).

## 5. Redaction rules (applied at capture time, not just at retention time)

- Request bodies: never stored verbatim. For JSON bodies we store a *key-shape* summary (sorted
  key names + value type + length bucket, e.g. `{"username": "string(1-32)", "password":
  "string(present)"}`) — enough to detect credential-stuffing shape without ever persisting the
  actual submitted password.
  - Special case: the literal field values submitted to `/login` and `/register` for the
    **username** are retained (usernames are the actual research value for credential-stuffing
    analysis and aren't secret); the **password** field value is *never* retained in any form,
    not even hashed — we only record `password_length_bucket` and `password_complexity_shape`
    (has_digit/has_symbol/has_upper booleans), which is enough to characterize wordlists without
    storing anything that could ever be a real person's real password.
- Headers: allowlisted set only (the ones listed in ARCHITECTURE.md/the brief's §4 list); anything
  outside the allowlist is counted (`header_count`, `unusual_header_names: string[]` capped at 10)
  but not stored verbatim beyond that cap, to bound both storage and the chance of accidentally
  capturing something sensitive stuffed into a custom header.
- Cookies: only *metadata* (names, count, whether a known session cookie is present) — cookie
  *values* are never logged except our own synthetic session token's opaque ID.
