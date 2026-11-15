// app/api/checkout/route.ts — add the assess call to your existing checkout handler.
import { NextRequest, NextResponse } from "next/server";
import { assessOrder, verdictFields, stripeMetadata } from "@/lib/uhoney.mjs";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const order = await createOrder(body); // your existing code

  const assessment = await assessOrder({
    sessionToken: body.uhoney_token,
    order: { id: order.id, amount: order.totalCents, currency: order.currency },
    ip: (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "0.0.0.0",
    headers: req.headers,
    method: req.method,
    path: req.nextUrl.pathname,
    host: req.headers.get("host") ?? undefined,
  });
  await saveOrderFields(order.id, verdictFields(assessment)); // your existing code
  // Stripe: metadata: { order_id: order.id, ...stripeMetadata(assessment) }

  return NextResponse.json({ orderId: order.id }); // your existing response, unchanged
}
