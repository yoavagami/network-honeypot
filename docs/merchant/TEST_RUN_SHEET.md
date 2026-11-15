# M6 run sheet — new website, agentic integration test

This is the acceptance test for the merchant platform. Have a fresh coding agent integrate a shop that has never
seen uHoney, then check that lab runs on that shop show correctly in its merchant dashboard.

## 0. Build the test shop (you)

- A small shop on a **different domain** from `uhoney.shop`, so cross-origin calls, domain registration and
  verification are really exercised.
- Suggested stack: **Next.js (App Router) + Stripe test mode**, with product page, cart, checkout and an order
  confirmation. Any stack with a real backend works.
- A privacy notice page.
- Commit it to git **before** any uHoney code, so the agent's diff shows exactly what integration means.
- Put your Stripe **test** keys in its `.env.local` yourself.

## 1. Onboard (you, through the real flow)

| Step | Where | Check |
|---|---|---|
| Request access with the test shop's details | `https://uhoney.shop/merchants` | "Thanks…" message |
| Approve it | Dashboard → **Merchants** | Invite link shown; copy it |
| Accept the invite | the invite link | Lands on **Integration** in `/m` |
| Create a **test** secret key | `/m` → Settings → Keys | Shown once; store it |
| Add the shop's domain | `/m` → Settings → Domains | Listed as "not verified" (fine for test keys) |
| Write down anything confusing | — | Becomes a fix to the docs |

Put `UHONEY_SITE_KEY` / `NEXT_PUBLIC_UHONEY_SITE_KEY` (the `pk_test_` key) and `UHONEY_SECRET_KEY` in the shop's `.env.local`.

## 2. Agentic integration (agent, no help from you)

Start a **new** coding-agent session in the shop's repository, with no earlier context. Give it exactly:

> Integrate uHoney using https://uhoney.shop/integrate/v1/agent.md

Rules for you during the run:

- Approve or reject its plan; give no other hints.
- Write down every question it asks and every place it gets stuck.
- When it asks you to place a test order, do it once.

Record:

| Measure | Target | Result |
|---|---|---|
| Minutes from prompt to local checks passing | under 30 | |
| Questions asked / places stuck | 0 beyond the plan approval and the test order | |
| Secret key anywhere in client code, logs or git | never | |
| Checkout still works with uHoney unreachable (agent's own test) | yes | |
| `UHONEY_INTEGRATION.md` written | yes | |
| Status: all local checks pass (webhook pending until deployed) | yes | |

Repeat once with a second agent product, to make sure the file doesn't depend on one agent's habits.

## 3. Deploy the shop and finish the webhook (you)

- Deploy the shop to its domain over HTTPS.
- `/m` → Settings → Webhooks: add `https://<shop>/api/webhooks/uhoney`, store the secret as
  `UHONEY_WEBHOOK_SECRET`, redeploy, press **Send test webhook**.
- Status call: `webhook_delivered` passes.

## 4. Accuracy runs (test mode, on the deployed shop)

Use signed lab links if you want them labelled in the honeypot too; in the merchant dashboard, note each run's
time so you can match it to its visit.

| # | Who | Scenario | Expected driver | Got | Expected suggestion | Got |
|---|---|---|---|---|---|---|
| 1–3 | In-browser agent (e.g. Claude in Chrome) | Buy with test card, agent does everything | `agent` | | `review` | |
| 4–6 | In-browser agent | Agent browses and fills the form; **you** press Pay | `agent_then_human` (handover on the payment page) | | `allow` | |
| 7–8 | Cloud browser agent | Buy with test card | `agent` | | `review` | |
| 9–10 | Scripted browser (Playwright) | Buy with test card | `agent` / automation | | `review` | |
| 11–20 | You and Hilla, desktop and phone | Normal purchase | `human` | | `allow` | |
| 21–23 | You, with the page script blocked (extension or CSP) | Normal purchase | verdict with `no_client_signals` | | `allow` | |

Pass: at least 9 of 10 agent runs (1–10) show the expected driver; 0 of 10 human runs (11–20) marked as agent.

## 5. Failure tests

| Test | How | Expected |
|---|---|---|
| uHoney down | Point `UHONEY_API_URL` at an unreachable host, place an order | Order completes; no verdict saved |
| Wrong key | Set a wrong `UHONEY_SECRET_KEY`, place an order | Order completes; status shows `key_valid` failing |
| Isolation | Create a second merchant, sign in as it | Sees none of the first merchant's visits or orders |
| Admin view | Dashboard → Merchant traffic, filter to the test merchant | Shows only that merchant; access log has `view_merchant_data` |

## 6. Report back

Send the tables above. Every stall or wrong step becomes a fix to `docs/integrate`, then a re-run with a fresh agent.
