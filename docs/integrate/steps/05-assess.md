## 5. Call Assess on your server, before the charge

In the server code that creates or confirms the payment, call `POST /v1/assess` with the session token, the order, and the visitor's request. Use the helper for your stack (recipes below); for Node.js it is:

{{snippet:node/uhoney.mjs}}

What the helper guarantees, and any hand-written version must too:

- a **300 ms timeout**; on timeout or any error it returns `null` and **the payment continues unchanged**;
- the visitor's IP, user agent and the listed headers are forwarded — **never** `cookie` or `authorization`;
- `Idempotency-Key` is the order id, so a retried checkout gets the same assessment.

Save `assessment_id`, `driver` and `suggested_action` on the order. With Stripe, also put `stripeMetadata(assessment)` into the PaymentIntent's `metadata`, so Radar rules can use it (for example: review if `uhoney_action` is `review`).

The response looks like this (full contract: `{{API_URL}}/integrate/v1/openapi.json`):

```json
{
  "assessment_id": "as_9fK2aB7cD1eF3gH5iJ6k",
  "driver": "agent_then_human",
  "handover": { "page": "/checkout/payment", "at": "2026-11-15T10:42:07Z" },
  "agent": { "id": "claude-in-chrome", "operator": "Anthropic", "verified": false, "verification": null },
  "score": 0.97,
  "confidence": "high",
  "suggested_action": "allow",
  "final": false
}
```

**Check:** place a test order: `assess_called`, `assess_headers` and `assess_latency` pass.
