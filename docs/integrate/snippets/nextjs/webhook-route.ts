// app/api/webhooks/uhoney/route.ts
import { NextRequest, NextResponse } from "next/server";
import { verifyWebhook, verdictFields } from "@/lib/uhoney.mjs";

export async function POST(req: NextRequest) {
  const raw = await req.text(); // raw body: needed for the signature
  if (!verifyWebhook(raw, req.headers.get("uhoney-signature") ?? undefined)) {
    return new NextResponse("bad signature", { status: 400 });
  }
  const event = JSON.parse(raw);
  if (event.type === "assessment.updated") {
    const a = event.data.assessment;
    await updateOrderFieldsByAssessment(a.assessment_id, verdictFields(a)); // your existing code
  }
  return new NextResponse("ok");
}
