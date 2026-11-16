## 4. Mark the Pay button and send the session token

Tell uHoney when Pay is pressed, and make sure your checkout request carries the session token:

{{snippet:browser/pay-button.js}}

- Classic `<form method="post">` checkouts get a hidden `uhoney_token` field automatically — nothing to do.
- Custom checkouts (fetch, JSON, SPA) send `uhoney.token()` as `uhoney_token` with the checkout request.
- **Recommended:** send the shopping steps the same way — `uhoney.track("product_viewed")` on product pages, `uhoney.track("add_to_cart")`, and `uhoney.track("checkout_started")` when checkout opens. They're optional, but they fill in the visit's shop journey in the dashboard and help tell browsing agents from shoppers (for example, a cart-to-payment run in seconds).

**Check:** press Pay once in test mode: `pay_event_seen` passes.
