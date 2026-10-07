import { NextResponse, type NextRequest } from "next/server";
import Stripe from "stripe";
import { handleStripeWebhook } from "@/server/billing/payments";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  try {
    await handleStripeWebhook(raw, req.headers.get("stripe-signature"));
  } catch (err) {
    if (err instanceof Stripe.errors.StripeSignatureVerificationError || (err as Error).message === "Missing stripe-signature") {
      return NextResponse.json({ error: "invalid signature" }, { status: 400 });
    }
    console.error("Stripe webhook failed", err);
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
