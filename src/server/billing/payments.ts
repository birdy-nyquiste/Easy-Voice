import { randomUUID } from "node:crypto";
import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "@/db";
import { ledgerEntries, payments, type User } from "@/db/schema";
import type { Locale } from "@/i18n/locales";
import { translator } from "@/i18n/messages";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { failureColumns, stored, type StoredText } from "@/lib/stored-text";
import { withWebhookDedupe } from "@/server/webhooks";
import { applyLedger } from "./ledger";

/** Checkout pages in the interface language. */
const CHECKOUT_LOCALE: Record<Locale, Stripe.Checkout.SessionCreateParams.Locale> = { en: "en", zh: "zh", es: "es-419", ja: "ja", vi: "vi" };

let stripeClient: Stripe | undefined;
function stripe(): Stripe {
  stripeClient ??= new Stripe(config.stripe.secretKey);
  return stripeClient;
}

/** Creates a Stripe Checkout session for a one-time top-up and returns its URL. */
export async function createTopup(user: User, amountCents: number, locale: Locale): Promise<string> {
  if (!Number.isInteger(amountCents) || amountCents < config.pricing.minTopupCents) {
    throw new UserError("minTopup", { amount: config.pricing.minTopupCents / 100 });
  }
  if (amountCents > config.pricing.maxTopupCents) throw new UserError("maxTopup", { amount: config.pricing.maxTopupCents / 100 });

  // Stripe is the only way money enters the system; there is no free-credit path.
  if (!config.stripe.enabled) throw new UserError("paymentsNotConfigured");

  // Known before the session exists, so the cancel page can say which checkout to close.
  const paymentId = randomUUID();
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer_email: user.email,
    locale: CHECKOUT_LOCALE[locale],
    client_reference_id: user.id,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: { name: translator(locale, "billing")("checkoutItem") },
        },
      },
    ],
    metadata: { userId: user.id },
    // Stripe fills in {CHECKOUT_SESSION_ID}, so the return page can credit without waiting for the webhook.
    success_url: `${config.appUrl}/account/billing?topup=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.appUrl}/account/billing?topup=cancelled&payment=${paymentId}`,
  });
  await db.insert(payments).values({ id: paymentId, userId: user.id, provider: "stripe", providerRef: session.id, amountCents });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

/** Dev-only: credit the balance directly. Recorded as an adjustment, never as a payment. */
export async function addDevCredit(user: User, amountCents: number): Promise<void> {
  if (!config.devCreditEnabled) throw new UserError("notAvailable");
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > config.pricing.maxTopupCents) {
    throw new UserError("invalidAmount");
  }
  await applyLedger({
    userId: user.id,
    amountCents,
    kind: "adjustment",
    idempotencyKey: `dev-credit:${randomUUID()}`,
    description: stored("ledgerDevCredit", { amount: amountCents / 100 }),
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
        description: stored("ledgerTopup", { amount: p.amountCents / 100 }),
        refType: "payment",
        refId: p.id,
      },
      tx,
    );
  });
}

/**
 * Where a top-up stands when the user comes back from Checkout: "credited" if it was paid and credited
 * just now, "succeeded" or "failed" if it was settled before, "processing" for a payment method that
 * takes days to clear (bank debits), "pending" when Stripe couldn't say.
 */
export type ReturnedTopup = "credited" | "succeeded" | "processing" | "pending" | "failed";

/**
 * Credits a paid checkout as soon as the user is back from Stripe, rather than waiting for the webhook
 * (which may arrive a few seconds later, or not at all if it's misconfigured). Null if it isn't theirs.
 */
export async function settleReturnedTopup(userId: string, sessionId: string): Promise<ReturnedTopup | null> {
  const [p] = await db.select().from(payments).where(and(eq(payments.providerRef, sessionId), eq(payments.userId, userId)));
  if (!p) return null;
  if (p.status !== "pending") return p.status;
  if (!config.stripe.enabled) return "pending";
  try {
    // Short and without retries: the page asks again on its next refresh, and the webhook settles it anyway.
    const s = await stripe().checkout.sessions.retrieve(sessionId, {}, { timeout: 5000, maxNetworkRetries: 0 });
    if (s.payment_status === "paid") {
      await completePayment(sessionId); // idempotent with the webhook
      return "credited";
    }
    if (s.status === "complete") return "processing";
  } catch (err) {
    console.error("Checkout session lookup failed", sessionId, err);
  }
  return "pending";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The user cancelled at Checkout: expire the session now, so it isn't listed as a pending payment for
 * the 24 hours Stripe would keep it open.
 */
export async function cancelTopup(userId: string, paymentId: string): Promise<void> {
  if (!UUID.test(paymentId) || !config.stripe.enabled) return;
  const [p] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.userId, userId), eq(payments.status, "pending")));
  if (!p) return;
  try {
    await stripe().checkout.sessions.expire(p.providerRef);
  } catch (err) {
    // Paid in another tab, or already expired: the webhook settles it.
    console.warn("Checkout session not expired", p.providerRef, err);
    return;
  }
  await failPayment(p.providerRef, stored("checkoutExpired"));
}

export async function failPayment(providerRef: string, reason: StoredText): Promise<void> {
  await db
    .update(payments)
    .set({ status: "failed", ...failureColumns(reason), completedAt: new Date() })
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
        await failPayment(event.data.object.id, stored("paymentFailed"));
        break;
      case "checkout.session.expired":
        await failPayment(event.data.object.id, stored("checkoutExpired"));
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

/** Payments made or attempted. Checkouts left without paying aren't listed: nothing was charged. */
export async function listPayments(userId: string, limit = 20) {
  return db
    .select()
    .from(payments)
    .where(and(eq(payments.userId, userId), sql`${payments.failureMsg}->>'key' is distinct from 'stored.checkoutExpired'`))
    .orderBy(desc(payments.createdAt))
    .limit(limit);
}
