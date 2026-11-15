### Anything else

The integration is the same three pieces in any language:

1. The tag (step 3) in the shared layout, and `uhoney.track("pay_clicked", { orderId })` on Pay (step 4).
2. One HTTPS call from your server before the charge: `POST {{API_URL}}/v1/assess` with `Authorization: Bearer <secret key>`, `Idempotency-Key: <order id>`, a 300 ms timeout, and the body from step 5 — continue the payment on any error.
3. A webhook endpoint that verifies `Uhoney-Signature` (`t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` with your `whsec_` secret) and updates the order.
