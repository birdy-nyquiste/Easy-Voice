import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db, withUserLock } from "@/db";
import { agents, phoneNumbers, type PhoneNumber, type User } from "@/db/schema";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { failureColumns, stored, type StoredText } from "@/lib/stored-text";
import { formatCents } from "@/lib/format";
import { applyLedger, chargePurchase, refundPurchase, type Purchase } from "./billing/ledger";
import { enableInboundSms } from "./messages";
import { voiceProvider } from "./telnyx";

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export async function listUserNumbers(userId: string): Promise<PhoneNumber[]> {
  return db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.userId, userId), ne(phoneNumbers.status, "released")));
}

export async function searchAvailableNumbers(areaCode: string) {
  if (areaCode && !/^\d{3}$/.test(areaCode)) throw new UserError("areaCodeDigits");
  return voiceProvider().searchNumbers({ areaCode: areaCode || undefined, limit: 10 });
}

function numberPurchase(n: Pick<PhoneNumber, "id" | "userId" | "e164">): Purchase {
  return {
    userId: n.userId,
    priceCents: config.pricing.numberMonthlyCents,
    kind: "number_monthly",
    key: `number:${n.id}:0`,
    description: stored("ledgerNumberFirstMonth", { number: n.e164 }),
    refType: "phone_number",
    refId: n.id,
  };
}

/** Buy a number: charges the first month up front, refunds if the order fails. */
export async function purchaseNumber(user: User, e164: string): Promise<PhoneNumber> {
  if (!/^\+1\d{10}$/.test(e164)) throw new UserError("invalidUsNumber");

  // Limit check, row insert and charge commit together under the user's lock.
  const row = await withUserLock(user.id, async (tx) => {
    const existing = await tx
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.userId, user.id), inArray(phoneNumbers.status, ["pending", "active"])));
    if (existing.length >= config.limits.numbersPerUser) {
      throw new UserError("numberLimit", { max: config.limits.numbersPerUser });
    }
    const [inserted] = await tx.insert(phoneNumbers).values({ userId: user.id, e164, status: "pending" }).returning();
    await chargePurchase(
      numberPurchase(inserted),
      new UserError("numberInsufficientBalance", { price: formatCents(config.pricing.numberMonthlyCents) }),
      tx,
    );
    return inserted;
  });

  try {
    const order = await voiceProvider().orderNumber(e164);
    const [updated] = await db
      .update(phoneNumbers)
      .set({ providerOrderId: order.orderId, providerNumberId: order.numberId, paidThrough: new Date(Date.now() + MONTH_MS) })
      .where(eq(phoneNumbers.id, row.id))
      .returning();
    if (order.status === "failure") return failNumber(updated, order.failureReason ?? stored("numberOrderRejected"));
    if (order.status === "success") return activateNumber(updated, order.numberId);
    return updated;
  } catch (err) {
    console.error("orderNumber failed", err);
    await failNumber(row, stored("numberCouldNotOrder"));
    throw new UserError("numberOrderFailed");
  }
}

async function activateNumber(n: PhoneNumber, numberId?: string): Promise<PhoneNumber> {
  const [u] = await db
    .update(phoneNumbers)
    .set({ status: "active", providerNumberId: numberId ?? n.providerNumberId, failureReason: null, failureMsg: null })
    .where(eq(phoneNumbers.id, n.id))
    .returning();
  // Receiving texts is a bonus; a failure here must not fail the purchase (the daily cron retries).
  if (await enableInboundSms(u)) return { ...u, smsEnabledAt: new Date() };
  return u;
}

async function failNumber(n: PhoneNumber, reason: StoredText): Promise<PhoneNumber> {
  await refundPurchase(numberPurchase(n), stored("ledgerNumberRefund", { number: n.e164 }));
  const [u] = await db
    .update(phoneNumbers)
    .set({ status: "failed", ...failureColumns(reason) })
    .where(eq(phoneNumbers.id, n.id))
    .returning();
  return u;
}

/** Poll the provider for pending orders (called on page view and by cron). */
export async function refreshPendingNumbers(userId?: string): Promise<void> {
  const pending = await db
    .select()
    .from(phoneNumbers)
    .where(userId ? and(eq(phoneNumbers.status, "pending"), eq(phoneNumbers.userId, userId)) : eq(phoneNumbers.status, "pending"));
  for (const n of pending) {
    if (!n.providerOrderId) continue;
    try {
      const order = await voiceProvider().getNumberOrder(n.providerOrderId);
      if (order.status === "success") await activateNumber(n, order.numberId);
      else if (order.status === "failure") await failNumber(n, order.failureReason ?? stored("numberOrderFailed"));
    } catch (err) {
      console.error("getNumberOrder failed", n.id, err);
    }
  }
}

export async function releaseNumber(userId: string, numberId: string, reason: StoredText = stored("numberReleasedByUser")): Promise<void> {
  const [n] = await db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.id, numberId), eq(phoneNumbers.userId, userId)));
  if (!n || n.status === "released") throw new UserError("numberNotFound");
  if (n.providerNumberId && n.status === "active") await voiceProvider().releaseNumber(n.providerNumberId);
  await db
    .update(phoneNumbers)
    .set({
      status: "released",
      agentId: null,
      releasedAt: new Date(),
      // A failed number keeps the reason it failed.
      ...(n.status === "failed" ? {} : failureColumns(reason)),
    })
    .where(eq(phoneNumbers.id, n.id));
}

export async function assignAgentToNumber(userId: string, numberId: string, agentId: string | null): Promise<void> {
  const [n] = await db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.id, numberId), eq(phoneNumbers.userId, userId)));
  if (!n || n.status === "released") throw new UserError("numberNotFound");
  if (agentId) {
    const [a] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.userId, userId)));
    if (!a || a.deletedAt) throw new UserError("agentNotFound");
  }
  await db.update(phoneNumbers).set({ agentId }).where(eq(phoneNumbers.id, n.id));
}

/** Monthly renewals; balance may go negative (release happens after the grace period). */
export async function chargeNumberRenewals(now = new Date()): Promise<number> {
  const due = await db.select().from(phoneNumbers).where(eq(phoneNumbers.status, "active"));
  let charged = 0;
  for (const n of due) {
    if (!n.paidThrough || n.paidThrough > now) continue;
    await applyLedger({
      userId: n.userId,
      amountCents: -config.pricing.numberMonthlyCents,
      kind: "number_monthly",
      idempotencyKey: `number:${n.id}:${n.paidThrough.toISOString()}`,
      description: stored("ledgerNumberMonthly", { number: n.e164 }),
      refType: "phone_number",
      refId: n.id,
    });
    await db
      .update(phoneNumbers)
      .set({ paidThrough: new Date(n.paidThrough.getTime() + MONTH_MS) })
      .where(eq(phoneNumbers.id, n.id));
    charged++;
  }
  return charged;
}
