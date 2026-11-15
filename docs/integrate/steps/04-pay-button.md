## 4. Mark the Pay button and send the session token

Tell uHoney when Pay is pressed, and make sure your checkout request carries the session token:

{{snippet:browser/pay-button.js}}

- Classic `<form method="post">` checkouts get a hidden `uhoney_token` field automatically — nothing to do.
- Custom checkouts (fetch, JSON, SPA) send `uhoney.token()` as `uhoney_token` with the checkout request.
- Other events you may send the same way: `checkout_started`, `add_to_cart`, `product_viewed`.

**Check:** press Pay once in test mode: `pay_event_seen` passes.
