## 7. Verify

```bash
curl -s {{API_URL}}/v1/integration/status -H "Authorization: Bearer $UHONEY_SECRET_KEY"
```

Every check is `pass` or `not_applicable` (`all_passed: true`). Each failing check's `detail` says exactly what to fix, and `recent_events` shows the last five things uHoney received from you. The same checklist is in the dashboard under Integration.

On localhost it is normal for `webhook_delivered` to fail until the webhook endpoint is reachable over HTTPS.
