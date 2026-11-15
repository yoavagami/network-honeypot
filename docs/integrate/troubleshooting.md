## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `tag_seen` fails, no errors visible | Content Security Policy blocks the tag | Allow `{{TAG_HOST}}` in `script-src` and `{{API_HOST}}` in `connect-src` |
| Beacons answer 403 `origin_not_allowed` | Domain not registered (test) or not verified (live) | Settings → Domains |
| `wrong_key_type` | A `pk_` key on the server, or an `sk_` key in the browser | Site key in the tag, secret key on the server |
| `assess_called` fails with "without a valid session token" | The checkout request doesn't carry `uhoney_token` | Classic forms: check the form is `method="post"`; custom checkouts: send `uhoney.token()` |
| `token_issued` fails | `data-consent="pending"` and consent never given | Call `uhoney.consent(true)` after consent |
| Assess often returns `null` in your logs | Network latency over 300 ms to the API | Check the server region; never raise the timeout above 1 s |
| `webhook_delivered` fails | Endpoint not public HTTPS, slow, or signature check fails | Use the raw body; answer 2xx within 5 s |
