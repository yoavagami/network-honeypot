// Express: add the assess call to your existing checkout route, and a webhook route.
import express from "express";
import { assessOrder, verdictFields, stripeMetadata, verifyWebhook } from "./uhoney.mjs";

const app = express();
app.set("trust proxy", 1); // so req.ip is the visitor's IP behind your load balancer

app.post("/checkout", express.urlencoded({ extended: false }), async (req, res) => {
  const order = await createOrder(req.body); // your existing code

  // uHoney: before the charge. Never throws; null means "no verdict" and the payment continues.
  const assessment = await assessOrder({
    sessionToken: req.body.uhoney_token,
    order: { id: order.id, amount: order.totalCents, currency: order.currency },
    ip: req.ip,
    headers: req.headers,
    method: req.method,
    path: req.originalUrl,
    host: req.get("host"),
  });
  await saveOrderFields(order.id, verdictFields(assessment)); // your existing code

  // With Stripe: add the verdict to the PaymentIntent so Radar rules can use it.
  // await stripe.paymentIntents.create({ amount: order.totalCents, currency: order.currency, metadata: { order_id: order.id, ...stripeMetadata(assessment) } });

  res.redirect(303, `/orders/${order.id}`); // your existing flow, unchanged
});

// Webhooks need the raw body for the signature check.
app.post("/webhooks/uhoney", express.raw({ type: "application/json" }), async (req, res) => {
  const raw = req.body.toString("utf8");
  if (!verifyWebhook(raw, req.get("uhoney-signature"))) return res.status(400).send("bad signature");
  const event = JSON.parse(raw);
  if (event.type === "assessment.updated") {
    const a = event.data.assessment;
    await updateOrderFieldsByAssessment(a.assessment_id, verdictFields(a)); // your existing code
  }
  res.status(200).send("ok");
});
