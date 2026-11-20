### Node.js with Express

1. Save the Node helper (step 5, also at `{{TAG_BASE}}/integrate/v1/uhoney.mjs`) next to your server code as `uhoney.mjs` (CommonJS projects: rename to `.mjs` and `import()` it, or convert the exports).
2. Add the tag (step 3) to your layout template.
3. Assess in the checkout route and add the webhook route:

{{snippet:express/checkout.mjs}}
