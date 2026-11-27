# uHoney integration changelog

The agent file and the developer guide are versioned by URL (`/integrate/v1/agent.md`). Breaking changes get a new
version path; additions are listed here.

| Date | Change |
| --- | --- |
| 2026-11-15 | v1 published: tag, `/v1/collect`, `/v1/assess`, `/v1/feedback`, `/v1/assessments/{id}`, `/v1/integration/status`, `assessment.updated` and `checkout.agent_started` webhooks. |
| 2026-11-27 | `/v1/assess` accepts optional cart detail (`order.items`, `order.shipping` with a hashed address, `order.payment.method`) and `intent_ref`, and returns `decision` (`allow`, `confirm`, `block`), `legitimacy`, `intent` and `evidence_id`. The default policy never returns `block`. The helpers pass the cart detail through and save `decision`. |
| 2026-11-20 | Helpers published as files: `/integrate/v1/uhoney.mjs`, `/integrate/v1/uhoney.php`. The agent file lists every file that exists and uses `XXXX` for placeholders. `llms.txt` is also at `/integrate/llms.txt`. |
