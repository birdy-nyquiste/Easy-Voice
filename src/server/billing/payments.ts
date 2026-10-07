import { randomUUID } from "node:crypto";
import "server-only";
import { and, desc, eq } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "@/db";
import { ledgerEntries, payments, type User } from "@/db/schema";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { formatCents } from "@/lib/format";
import { withWebhookDedupe } from "@/server/webhooks";
import { applyLedger } from "./ledger";

const MAX_TOPUP_CENTS = 50_000;

let stripeClient: Stripe | undefined;
function stripe(): Stripe {
  stripeClient ??= new Stripe(config.stripe.secretKey);
  return stripeClient;
}

/** Creates a Stripe Checkout session for a one-time top-up and returns its URL. */
export async function createTopup(user: User, amountCents: number): Promise<string> {
  if (!Number.isInteger(amountCents) || amountCents < config.pricing.minTopupCents) {
    throw new UserError(`Minimum top-up is ${formatCents(config.pricing.minTopupCents)}.`);
  }
  if (amountCents > MAX_TOPUP_CENTS) throw new UserError(`Maximum top-up is ${formatCents(MAX_TOPUP_CENTS)}.`);

  // Stripe is the only way money enters the system; there is no free-credit path.
  if (!config.stripe.enabled) throw new UserError("Payments aren't configured yet. Please try again later.");

  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer_email: user.email,
    client_reference_id: user.id,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: { name: "Easy Voice credit" },
        },
      },
    ],
    metadata: { userId: user.id },
    success_url: `${config.appUrl}/billing?topup=success`,
    cancel_url: `${config.appUrl}/billing?topup=cancelled`,
  });
  await db.insert(payments).values({ userId: user.id, provider: "stripe", providerRef: session.id, amountCents });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

/** Dev-only: credit the balance directly. Recorded as an adjustment, never as a payment. */
export async function addDevCredit(user: User, amountCents: number): Promise<void> {
  if (!config.devCreditEnabled) throw new UserError("Not available.");
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_TOPUP_CENTS) {
    throw new UserError("Invalid amount.");
  }
  await applyLedger({
    userId: user.id,
    amountCents,
    kind: "adjustment",
    idempotencyKey: `dev-credit:${randomUUID()}`,
    description: `Dev credit ${formatCents(amountCents)} (no payment)`,
  });
}

/** Idempotent: credits the balance once per payment. */
export async function completePayment(providerRef: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.providerRef, providerRef)).for("update");
    if (!p || p.status === "succeeded") return;
    await tx.update(payments).set({ status: "succeeded", completedAt: new Date() }).where(eq(payments.id, p.id));
    await applyLedger(
      {
        userId: p.userId,
        amountCents: p.amountCents,
        kind: "topup",
        idempotencyKey: `payment:${p.id}`,
        description: `Top-up ${formatCents(p.amountCents)}`,
        refType: "payment",
        refId: p.id,
      },
      tx,
    );
  });
}

export async function failPayment(providerRef: string, reason: string): Promise<void> {
  await db
    .update(payments)
    .set({ status: "failed", failureReason: reason, completedAt: new Date() })
    .where(and(eq(payments.providerRef, providerRef), eq(payments.status, "pending")));
}

export async function handleStripeWebhook(rawBody: string, signature: string | null): Promise<void> {
  if (!signature) throw new Error("Missing stripe-signature");
  const event = stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
  await withWebhookDedupe("stripe", event.id, event.type, async () => {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object;
        if (s.payment_status === "paid") await completePayment(s.id);
        break;
      }
      case "checkout.session.async_payment_failed":
        await failPayment(event.data.object.id, "Payment failed");
        break;
      case "checkout.session.expired":
        await failPayment(event.data.object.id, "Checkout expired");
        break;
    }
  });
}

export async function listLedger(userId: string, limit = 100) {
  return db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.userId, userId))
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(limit);
}

export async function listPayments(userId: string, limit = 20) {
  return db.select().from(payments).where(eq(payments.userId, userId)).orderBy(desc(payments.createdAt)).limit(limit);
}
