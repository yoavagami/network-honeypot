## Done means

**Without keys:** done means the code from steps 3–6 is in place, the example environment file lists the variables, the unit tests pass (checkout still succeeds when uHoney times out or fails; webhook signatures accepted and rejected correctly), and the report contains the after-deploy checklist below for the developer.

**With keys:** run the status call and read every check:

```bash
curl -s {{API_URL}}/v1/integration/status -H "Authorization: Bearer $UHONEY_SECRET_KEY"
```

- Locally, done means: `key_valid`, `tag_seen`, `token_issued`, `pay_event_seen`, `assess_called`, `assess_headers` and `assess_latency` are `pass`, and `domain_verified` is `not_applicable`.
- `webhook_delivered` can only pass once the webhook endpoint is reachable over public HTTPS. Implement and test the handler; then tell the developer to add the endpoint in the dashboard and press **Send test webhook** after deploying.
- To produce the events, run the site locally, open a page with the tag, and complete one test checkout (press Pay). If the project has no way to place a test order, ask the developer to do it once and re-run the status call.
- When a check fails, its `detail` says what to fix; `recent_events` shows what actually arrived.

## Report

Write `UHONEY_INTEGRATION.md` in the repository root (and use the same text as the pull request description) containing:

1. The stack and recipe used.
2. Every file changed or added, with one line each.
3. How to roll back (the files to revert).
4. The final status output, with the secret key not shown.
5. What the developer still has to do, as a checklist:
   - [ ] Set `UHONEY_SITE_KEY` (and the framework's public copy, e.g. `NEXT_PUBLIC_UHONEY_SITE_KEY`), `UHONEY_SECRET_KEY` and `UHONEY_WEBHOOK_SECRET` in each environment where the site runs.
   - [ ] Register the site's domain in the dashboard (Settings → Domains); test keys accept any registered domain.
   - [ ] Deploy, open a page, place one test order, and run the status call until every check passes.
   - [ ] Add the webhook endpoint in the dashboard and press **Send test webhook**.
   - [ ] At go-live: verify the domain, create live keys, swap the environment variables.

Then give the developer a short summary and the list of remaining human steps.

## References

- Machine-readable contract: `{{API_URL}}/integrate/v1/openapi.json`
- Developer guide (same steps): `{{DOCS_URL}}`
