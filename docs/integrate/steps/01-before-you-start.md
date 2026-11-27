## 1. Before you start

You need:

- An approved uHoney account. No account yet? Request access at `{{TAG_BASE}}/merchants`.
- Your **test keys** from the dashboard (`{{DASHBOARD_URL}}/m/settings` → Keys): the public site key `pk_test_XXXX` and a secret key `sk_test_XXXX` (shown once when you create it).
- Access to your site's shared page layout and to the server code that creates the charge.

Supported in v1: any site with its own backend. Recipes below for **Next.js**, **Node.js with Express** and **PHP**, plus a generic recipe for anything else. Stripe is covered; other payment providers work the same way without the Stripe metadata.

Two rules hold for every integration:

- **Fail open.** The checkout never waits more than 300 ms for uHoney and never fails because of it.
- **Advisory only.** Save the decision on the order. Acting on it (asking the shopper to confirm, holding the order) is your choice.
