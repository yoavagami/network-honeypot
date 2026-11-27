## 5. Call Assess on your server, before the charge

In the server code that creates or confirms the payment, call `POST /v1/assess` with the session token, the order, and the visitor's request. Use the helper for your stack (recipes below); for Node.js it is:

{{snippet:node/uhoney.mjs}}

What the helper guarantees, and any hand-written version must too:

- a **300 ms timeout**; on timeout or any error it returns `null` and **the payment continues unchanged**;
- the visitor's IP, user agent and the listed headers are forwarded — **never** `cookie` or `authorization`;
- `Idempotency-Key` is the order id, so a retried checkout gets the same assessment.

Save `assessment_id`, `driver` and `decision` on the order. `decision` is the verdict, from the merchant's policy: `allow`, `confirm` (the checkout should get the shopper's own approval of the cart before charging) or `block` (don't take the payment); the default policy never returns `block`. Until the checkout has a confirmation step, the decision is advisory: save it and let the payment continue. With Stripe, also put `stripeMetadata(assessment)` into the PaymentIntent's `metadata`, so Radar rules can use it (for example: review if `uhoney_decision` is `confirm`).

Optional, and worth sending: the cart lines (`items`: `sku`, `title`, `category`, `quantity`, `unit_amount` in cents), `shipping` (`country`, `new_address`, and `address_hash`: your own hash of the normalized address, never the address itself) and `payment.method`. uHoney uses them to check that the cart matches what the shopper asked for. Never send names, emails, phone numbers or the address in clear.

The response looks like this (full contract: `{{API_URL}}/integrate/v1/openapi.json`):

```json
{
  "assessment_id": "as_9fK2aB7cD1eF3gH5iJ6k",
  "driver": "agent_then_human",
  "handover": { "page": "/checkout/payment", "at": "2026-11-15T10:42:07Z" },
  "agent": { "id": "claude-in-chrome", "operator": "Anthropic", "verified": false, "verification": null },
  "score": 0.97,
  "confidence": "high",
  "decision": "allow",
  "legitimacy": { "evaluated": false, "score": null, "reasons": [] },
  "intent": { "status": "not_provided", "score": null, "violations": [] },
  "final": false
}
```

**Check:** place a test order: `assess_called`, `assess_headers` and `assess_latency` pass.
