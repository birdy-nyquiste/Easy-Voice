import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { agents, phoneNumbers, type PhoneNumber, type User } from "@/db/schema";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { formatCents } from "@/lib/format";
import { applyLedger, InsufficientBalanceError } from "./billing/ledger";
import { voiceProvider } from "./telnyx";

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export async function listUserNumbers(userId: string): Promise<PhoneNumber[]> {
  return db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.userId, userId), ne(phoneNumbers.status, "released")));
}

export async function searchAvailableNumbers(areaCode: string) {
  if (areaCode && !/^\d{3}$/.test(areaCode)) throw new UserError("Area code must be 3 digits.");
  return voiceProvider().searchNumbers({ areaCode: areaCode || undefined, limit: 10 });
}

/** Buy a number: charges the first month up front, refunds if the order fails. */
export async function purchaseNumber(user: User, e164: string): Promise<PhoneNumber> {
  if (!/^\+1\d{10}$/.test(e164)) throw new UserError("Invalid US number.");
  const price = config.pricing.numberMonthlyCents;

  const existing = await db
    .select({ id: phoneNumbers.id })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.userId, user.id), inArray(phoneNumbers.status, ["pending", "active"])));
  if (existing.length >= config.limits.numbersPerUser) {
    throw new UserError(`You can have up to ${config.limits.numbersPerUser} number(s).`);
  }

  const [row] = await db.insert(phoneNumbers).values({ userId: user.id, e164, status: "pending" }).returning();

  // Charge first; the ledger locks the user row so concurrent purchases can't overspend.
  try {
    await applyLedger({
      userId: user.id,
      amountCents: -price,
      kind: "number_monthly",
      idempotencyKey: `number:${row.id}:0`,
      description: `Phone number ${e164} — first month`,
      refType: "phone_number",
      refId: row.id,
      requireFunds: true,
    });
  } catch (err) {
    await db.delete(phoneNumbers).where(eq(phoneNumbers.id, row.id));
    if (err instanceof InsufficientBalanceError) {
      throw new UserError(`Insufficient balance. A number costs ${formatCents(price)}/month — top up first.`);
    }
    throw err;
  }

  try {
    const order = await voiceProvider().orderNumber(e164);
    const [updated] = await db
      .update(phoneNumbers)
      .set({ providerOrderId: order.orderId, providerNumberId: order.numberId, paidThrough: new Date(Date.now() + MONTH_MS) })
      .where(eq(phoneNumbers.id, row.id))
      .returning();
    if (order.status === "failure") return failNumber(updated, order.failureReason ?? "Order rejected by carrier");
    if (order.status === "success") return activateNumber(updated, order.numberId);
    return updated;
  } catch (err) {
    console.error("orderNumber failed", err);
    await failNumber(row, "The number could not be ordered (it may no longer be available).");
    throw new UserError("That number could not be ordered. Your payment was refunded — try another number.");
  }
}

async function activateNumber(n: PhoneNumber, numberId?: string): Promise<PhoneNumber> {
  const [u] = await db
    .update(phoneNumbers)
    .set({ status: "active", providerNumberId: numberId ?? n.providerNumberId, failureReason: null })
    .where(eq(phoneNumbers.id, n.id))
    .returning();
  return u;
}

async function failNumber(n: PhoneNumber, reason: string): Promise<PhoneNumber> {
  await applyLedger({
    userId: n.userId,
    amountCents: config.pricing.numberMonthlyCents,
    kind: "refund",
    idempotencyKey: `number:${n.id}:refund`,
    description: `Refund — number ${n.e164} could not be activated`,
    refType: "phone_number",
    refId: n.id,
  });
  const [u] = await db
    .update(phoneNumbers)
    .set({ status: "failed", failureReason: reason })
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
      else if (order.status === "failure") await failNumber(n, order.failureReason ?? "Order failed");
    } catch (err) {
      console.error("getNumberOrder failed", n.id, err);
    }
  }
}

export async function releaseNumber(userId: string, numberId: string, reason = "Released by user"): Promise<void> {
  const [n] = await db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.id, numberId), eq(phoneNumbers.userId, userId)));
  if (!n || n.status === "released") throw new UserError("Number not found.");
  if (n.providerNumberId && n.status === "active") await voiceProvider().releaseNumber(n.providerNumberId);
  await db
    .update(phoneNumbers)
    .set({ status: "released", agentId: null, releasedAt: new Date(), failureReason: n.status === "failed" ? n.failureReason : reason })
    .where(eq(phoneNumbers.id, n.id));
}

export async function assignAgentToNumber(userId: string, numberId: string, agentId: string | null): Promise<void> {
  const [n] = await db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.id, numberId), eq(phoneNumbers.userId, userId)));
  if (!n || n.status === "released") throw new UserError("Number not found.");
  if (agentId) {
    const [a] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.userId, userId)));
    if (!a || a.deletedAt) throw new UserError("Agent not found.");
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
      description: `Phone number ${n.e164} — monthly rental`,
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
