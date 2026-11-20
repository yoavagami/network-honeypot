### Next.js (App Router)

1. Save the Node helper (step 5, also at `{{TAG_BASE}}/integrate/v1/uhoney.mjs`) as `lib/uhoney.mjs` in the project.
2. Add `NEXT_PUBLIC_UHONEY_SITE_KEY` (the `pk_` key) and `UHONEY_SECRET_KEY` to `.env.local`.
3. Tag in the root layout:

{{snippet:nextjs/layout.tsx}}

4. Assess in the checkout route handler (or server action) before the payment is created:

{{snippet:nextjs/checkout-route.ts}}

5. Webhook route:

{{snippet:nextjs/webhook-route.ts}}

Pages Router: put the tag in `pages/_document.tsx` and use the same helper in `pages/api/checkout.ts`.
