## 6. Receive the final verdict by webhook

The verdict at Pay is preliminary (`final: false`). When the visit ends — or if the verdict changes after Pay — uHoney sends `assessment.updated` to your webhook endpoint. `checkout.agent_started` tells you an agent-driven visit reached checkout.

1. Add an endpoint in the dashboard (Settings → Webhooks), for example `https://shop.example.com/webhooks/uhoney`. Copy the signing secret (shown once) into `UHONEY_WEBHOOK_SECRET`.
2. In the handler, verify `Uhoney-Signature` against the **raw** body with `verifyWebhook()`, then update the saved verdict. Answer 2xx within 5 seconds. Deliveries retry for 24 hours, so the same event `id` can arrive twice — handle it idempotently.
3. Press **Send test webhook** in the dashboard.

Webhooks need a public HTTPS URL. On localhost, implement and unit-test the handler; `webhook_delivered` passes once the endpoint is deployed (or exposed with a tunnel).

**Check:** `webhook_delivered` passes.
