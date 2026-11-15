# uHoney Merchant API — v1 contract

The machine-readable source of truth is [`packages/merchant-contract/openapi.json`](../../packages/merchant-contract/openapi.json).
This page is the same contract in plain language. A test (`packages/merchant-contract/test/contract.test.ts`)
checks that the spec, its examples and the server's runtime schemas agree.

**Base URL:** `https://api.uhoney.shop` (the same API is also served at `https://uhoney.shop`).
**Tag:** `https://uhoney.shop/v1/tag.js`.

## Rules that never change within v1

- **Advisory only.** We suggest; the merchant decides. The default policy never suggests more than `review`.
- **Fail open.** Integrations call `/v1/assess` with a 300 ms timeout and let the payment continue on any error.
- **Additive changes only.** Fields and enum values may be added, never renamed or removed. Ignore unknown
  fields; treat an unknown enum value as `unknown`.
- **The key decides who you are.** The server derives the merchant from the key. A `Uhoney-Merchant` header,
  if sent, must match or the request is refused.

## Identifiers and keys

| Item | Format | Where it lives | What it can do |
|---|---|---|---|
| Merchant ID | `mer_` + 8 Crockford base32 (`mer_7Q2K9XRM`) | Dashboard, every response, logs | Nothing on its own — a label |
| Public site key | `pk_test_` / `pk_live_` + 24 | The page tag (public) | Send beacons from registered domains only |
| Secret key | `sk_test_` / `sk_live_` + 32 | Merchant server env `UHONEY_SECRET_KEY` | All server endpoints |
| Webhook secret | `whsec_` + 32 | Merchant server env `UHONEY_WEBHOOK_SECRET` | Verify our webhooks |
| Session token | `st_<payload>.<signature>` | Tag → checkout form field `uhoney_token` | Ties a checkout to its visit; 2 h, one merchant |
| Assessment ID | `as_` + 20 | Your order record | Fetch / update a verdict |

Test and live are separate worlds: test keys see test data only and also accept `localhost` and `127.0.0.1`.
Secret keys are shown once and stored hashed; a merchant can have two active secret keys while rotating.

## Endpoints

| Endpoint | Caller | Purpose |
|---|---|---|
| `POST /v1/collect` | Tag in the browser (`pk_`) | Beacons; returns the session token |
| `POST /v1/assess` | Merchant server (`sk_`) | Verdict for an order at Pay |
| `GET /v1/assessments/{id}` | Merchant server | The assessment again, including the final verdict |
| `POST /v1/feedback` | Merchant server | What really happened (chargeback, confirmed agent…) |
| `GET /v1/integration/status` | Merchant server / developer / coding agent | Verification checklist |

Server calls send `Authorization: Bearer sk_…`. `/v1/assess` honours `Idempotency-Key` (defaults to `order.id`).

### Assess at Pay

Request: the session token (if the form carried one), the order (`id`, `amount` in minor units, `currency`),
and the visitor's request as the merchant received it — `ip`, `user_agent`, and optionally `method`, `path`,
`host` and lower-case `headers` (send `accept*`, `sec-ch-ua*`, `sec-fetch-*`, and `signature`, `signature-input`,
`signature-agent` when present; never `cookie` or `authorization`).

Response fields:

| Field | Meaning |
|---|---|
| `driver` | `human`, `agent`, `agent_then_human`, `human_then_agent`, `mixed`, `unknown` |
| `handover` | Where and when control changed hands (`null` if it didn't) |
| `automation_type` | `cloud_browser_agent`, `in_browser_agent`, `browser_automation`, `script`, … or `human` / `unknown` |
| `agent` | `{ id, operator, verified, verification }` or `null`. `verified` only with proof: `web_bot_auth`, `published_ip_range`, `reverse_dns` |
| `score` | 0–1 probability that an AI agent was involved (not yet calibrated) |
| `confidence` | `low`, `medium`, `high` |
| `reasons` | Up to 8 `{ code, text }`. Codes are the scorer's signal ids plus `no_client_signals`, `session_token_invalid`, `web_bot_auth_unverified` |
| `signals_used` | Whether page-script (`client`) and server-side signals contributed |
| `suggested_action` | `allow`, `review`, `challenge` — from the merchant's policy |
| `final` | `false` at Pay; `true` once the visit has ended |

A bad, expired or missing token never causes an error — the verdict rests on server signals and says so.

### Default policy

| Situation | Suggests |
|---|---|
| Verified agent | `allow` |
| Unverified agent drove the checkout | `review` |
| Agent browsed, a person paid (`agent_then_human`) | `allow` |
| Uncertain | `allow` |

## Webhooks

`assessment.updated` (final verdict, or a change after Pay) and `checkout.agent_started` (an agent-driven visit
reached checkout). Envelope: `{ id: "evt_…", type, created_at, livemode, merchant_id, data }`.

Signature header: `Uhoney-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256("<t>.<raw body>", whsec_…)>`.
Reject signatures older than 5 minutes. Respond 2xx within 5 s; failures retry with backoff for 24 h, so the same
event `id` can arrive more than once.

## Errors

`{ "error": { "code", "message", "request_id" } }`

| Code | HTTP |
|---|---|
| `invalid_request` | 400 |
| `invalid_key`, `key_revoked` | 401 |
| `wrong_key_type`, `merchant_mismatch`, `origin_not_allowed` | 403 |
| `not_found` | 404 |
| `idempotency_conflict` | 409 |
| `rate_limited` | 429 (with `RateLimit-*` headers) |
| `internal_error` | 500 |

## Integration status checks

`key_valid`, `tag_seen`, `token_issued`, `pay_event_seen`, `assess_called`, `assess_headers`, `assess_latency`,
`webhook_delivered`, `domain_verified` (live only). Each is `pass`, `fail`, `pending` or `not_applicable`, with a
one-line `detail` that says how to fix it.
