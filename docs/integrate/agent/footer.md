## Done means

Run the status call and read every check:

```bash
curl -s {{API_URL}}/v1/integration/status -H "Authorization: Bearer $UHONEY_SECRET_KEY"
```

- Locally, done means: `key_valid`, `tag_seen`, `token_issued`, `pay_event_seen`, `assess_called`, `assess_headers` and `assess_latency` are `pass`, and `domain_verified` is `not_applicable`.
- `webhook_delivered` can only pass once the webhook endpoint is reachable over public HTTPS. Implement and test the handler; then tell the developer to add the endpoint in the dashboard and press **Send test webhook** after deploying.
- To produce the events, run the site locally, open a page with the tag, and complete one test checkout (press Pay). If the project has no way to place a test order, ask the developer to do it once and re-run the status call.
- When a check fails, its `detail` says what to fix; `recent_events` shows what actually arrived.

## Report

Write `UHONEY_INTEGRATION.md` in the repository root containing:

1. The stack and recipe used.
2. Every file changed or added, with one line each.
3. How to roll back (the files to revert).
4. The final status output, with the secret key not shown.
5. What the developer still has to do: webhook endpoint in the dashboard, domain verification, live keys at go-live.

Then give the developer a short summary and the list of remaining human steps.

## References

- Machine-readable contract: `{{API_URL}}/integrate/v1/openapi.json`
- Developer guide (same steps): `{{DOCS_URL}}`
