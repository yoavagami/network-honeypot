## 8. Go live

1. Add your production domain (Settings → Domains) and verify it with the DNS TXT record or the meta tag shown there. Live keys require a verified domain.
2. Create a live secret key, and copy the live site key.
3. Swap the environment variables in production to `pk_live_XXXX` / `sk_live_XXXX`, add a live webhook endpoint, and deploy.
4. Run the status call with the live secret key until it passes, and switch the dashboard to **Live data**.
