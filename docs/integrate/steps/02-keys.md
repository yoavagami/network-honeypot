## 2. Store the keys

Add the keys to your server environment (for local development, the project's `.env`, which must stay out of git):

```bash
UHONEY_SITE_KEY=pk_test_XXXX       # public: used in the page tag
UHONEY_SECRET_KEY=sk_test_XXXX     # secret: server only
UHONEY_WEBHOOK_SECRET=whsec_XXXX   # from step 6
```

Frameworks that expose public variables need a public copy of the site key (Next.js: `NEXT_PUBLIC_UHONEY_SITE_KEY`). The secret key must never reach browser code, logs, commits or test fixtures.

**Check:**

```bash
curl -s {{API_URL}}/v1/integration/status -H "Authorization: Bearer $UHONEY_SECRET_KEY"
```

returns JSON with your `merchant_id` and `key_valid: pass`.
