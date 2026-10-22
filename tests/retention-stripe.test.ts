import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { calls, ledgerEntries, payments, phoneNumbers, users } from "@/db/schema";
import { config } from "@/lib/config";
import { applyLedger } from "@/server/billing/ledger";
import { handleStripeWebhook } from "@/server/billing/payments";
import { runDailyJobs } from "@/server/cron";
import { mockProvider } from "@/server/telnyx/mock";
import { makeLine, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("retention", () => {
  async function oldCall(daysAgo: number) {
    const { user, agent, number } = await makeLine(1000);
    const createdAt = new Date(Date.now() - daysAgo * 86_400_000);
    const [c] = await db
      .insert(calls)
      .values({
        userId: user.id, agentId: agent.id, phoneNumberId: number.id, direction: "inbound",
        fromNumber: "+12025550123", toNumber: number.e164, providerCallControlId: `cc-${daysAgo}`,
        status: "completed", endedAt: createdAt, createdAt, hasRecording: true,
        transcript: [{ role: "user", text: "hi" }], summary: "s", resultsFetched: true,
      })
      .returning();
    return c;
  }
  const load = async (id: string) => (await db.select().from(calls).where(eq(calls.id, id)))[0];

  it("purges content older than the retention window, locally and at the provider", async () => {
    const purge = vi.spyOn(mockProvider, "purgeCallData");
    const expired = await oldCall(config.policy.retentionDays + 1);
    const recent = await oldCall(1);
    await runDailyJobs();
    expect(purge).toHaveBeenCalledTimes(1);
    expect(await load(expired.id)).toMatchObject({ transcript: null, summary: null, hasRecording: false, resultsFetched: true });
    expect((await load(expired.id)).purgedAt).toBeInstanceOf(Date);
    expect((await load(recent.id)).transcript).not.toBeNull();
    await runDailyJobs(); // already purged → not repeated
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it("keeps local content and retries later if the provider purge fails", async () => {
    vi.spyOn(mockProvider, "purgeCallData").mockRejectedValueOnce(new Error("telnyx down"));
    const expired = await oldCall(config.policy.retentionDays + 1);
    await runDailyJobs();
    expect((await load(expired.id)).purgedAt).toBeNull();
    await runDailyJobs();
    expect((await load(expired.id)).purgedAt).toBeInstanceOf(Date);
  });
});

describe("daily jobs", () => {
  const days = (n: number) => new Date(Date.now() - n * 86_400_000);
  const grace = config.policy.negativeBalanceReleaseDays;
  /** A line whose balance is -$1.00 and has been negative for `daysNegative` days (null: in good standing). */
  async function lineNegativeFor(daysNegative: number | null) {
    const line = await makeLine(daysNegative === null ? 1000 : 0);
    if (daysNegative !== null) {
      await applyLedger({ userId: line.user.id, amountCents: -100, kind: "adjustment", idempotencyKey: `debt:${line.user.id}`, description: "debt" });
      await db.update(users).set({ negativeSince: days(daysNegative) }).where(eq(users.id, line.user.id));
    }
    return line;
  }
  const numberRow = async (id: string) => (await db.select().from(phoneNumbers).where(eq(phoneNumbers.id, id)))[0];

  it("release numbers only after the balance has stayed negative past the grace period", async () => {
    const overdue = await lineNegativeFor(grace + 1);
    const recent = await lineNegativeFor(grace - 1);
    const fine = await lineNegativeFor(null);
    await runDailyJobs();
    expect(await numberRow(overdue.number.id)).toMatchObject({
      status: "released",
      agentId: null,
      failureMsg: { key: "stored.numberReleasedNegative" },
      releasedAt: expect.any(Date),
    });
    expect((await numberRow(recent.number.id)).status).toBe("active");
    expect((await numberRow(fine.number.id)).status).toBe("active");
  });

  it("don't charge a renewal for a number they release in the same run", async () => {
    const { user, number } = await lineNegativeFor(grace + 1);
    await db.update(phoneNumbers).set({ paidThrough: days(1) }).where(eq(phoneNumbers.id, number.id));
    await runDailyJobs();
    expect((await numberRow(number.id)).status).toBe("released");
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.kind, "number_monthly"))).toEqual([]);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].balanceCents).toBe(-100);
  });

  it("run the retention purge even when a number release fails, and report the failure", async () => {
    const { user, number } = await makeLine(1000);
    await db.update(users).set({ negativeSince: new Date(Date.now() - 60 * 86_400_000) }).where(eq(users.id, user.id));
    vi.spyOn(mockProvider, "releaseNumber").mockRejectedValue(new Error("deletion locked"));
    const createdAt = new Date(Date.now() - (config.policy.retentionDays + 1) * 86_400_000);
    const [old] = await db
      .insert(calls)
      .values({
        userId: user.id, phoneNumberId: number.id, direction: "inbound", fromNumber: "+12025550123", toNumber: number.e164,
        providerCallControlId: "cc-old", status: "completed", endedAt: createdAt, createdAt, transcript: [{ role: "user", text: "hi" }],
      })
      .returning();
    await expect(runDailyJobs()).rejects.toThrow(/negative-balance releases/);
    expect((await db.select().from(calls).where(eq(calls.id, old.id)))[0].purgedAt).toBeInstanceOf(Date);
    expect((await db.select().from(phoneNumbers).where(eq(phoneNumbers.id, number.id)))[0].status).toBe("active"); // retried tomorrow
  });

  it("end calls whose hangup never arrived, without charging", async () => {
    const { user, number } = await makeLine(1000);
    const createdAt = new Date(Date.now() - 5 * 3_600_000);
    const [lost] = await db
      .insert(calls)
      .values({
        userId: user.id, phoneNumberId: number.id, direction: "inbound", fromNumber: "+12025550123", toNumber: number.e164,
        providerCallControlId: "cc-lost", status: "answered", answeredAt: createdAt, createdAt,
      })
      .returning();
    await runDailyJobs();
    const [row] = await db.select().from(calls).where(eq(calls.id, lost.id));
    expect(row).toMatchObject({ status: "failed", billedCents: 0, outcome: "We lost track of this call's status, so it wasn't charged." });
    expect(row.endedAt).toBeInstanceOf(Date);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].balanceCents).toBe(1000);
  });
});

describe("Stripe webhook", () => {
  const secret = "whsec_test_secret";
  beforeEach(() => {
    config.stripe.secretKey = "sk_test_dummy";
    config.stripe.webhookSecret = secret;
  });
  afterEach(() => {
    config.stripe.secretKey = "";
    config.stripe.webhookSecret = "";
  });

  function completedEvent(sessionId: string) {
    return JSON.stringify({
      id: `evt_${sessionId}`,
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: sessionId, object: "checkout.session", payment_status: "paid" } },
    });
  }

  it("credits once for a validly signed event, even if redelivered", async () => {
    const u = await makeUser(0);
    await db.insert(payments).values({ userId: u.id, provider: "stripe", providerRef: "cs_1", amountCents: 2500 });
    const payload = completedEvent("cs_1");
    const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    await handleStripeWebhook(payload, sig);
    await handleStripeWebhook(payload, sig);
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.balanceCents).toBe(2500);
  });

  /** Send one signed event about checkout session `sessionId`. */
  async function send(type: string, sessionId: string, fields: Record<string, unknown> = {}, eventId = `evt_${type}_${sessionId}`) {
    const payload = JSON.stringify({ id: eventId, object: "event", type, data: { object: { id: sessionId, object: "checkout.session", ...fields } } });
    await handleStripeWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }));
  }
  async function pendingPayment(ref: string) {
    const u = await makeUser(0);
    await db.insert(payments).values({ userId: u.id, provider: "stripe", providerRef: ref, amountCents: 2500 });
    return u;
  }
  const state = async (userId: string, ref: string) => ({
    balance: (await db.select().from(users).where(eq(users.id, userId)))[0].balanceCents,
    payment: (await db.select().from(payments).where(eq(payments.providerRef, ref)))[0],
  });

  it("doesn't credit a completed checkout that isn't paid yet (bank debit), then credits once when it is", async () => {
    const u = await pendingPayment("cs_async");
    await send("checkout.session.completed", "cs_async", { payment_status: "unpaid" });
    expect(await state(u.id, "cs_async")).toMatchObject({ balance: 0, payment: { status: "pending" } });
    await send("checkout.session.async_payment_succeeded", "cs_async", { payment_status: "paid" });
    await send("checkout.session.async_payment_succeeded", "cs_async", { payment_status: "paid" }, "evt_resent");
    expect(await state(u.id, "cs_async")).toMatchObject({ balance: 2500, payment: { status: "succeeded" } });
  });

  it("marks a failed or expired checkout as failed, and never un-credits a paid one", async () => {
    const failed = await pendingPayment("cs_failed");
    await send("checkout.session.async_payment_failed", "cs_failed");
    expect((await state(failed.id, "cs_failed")).payment).toMatchObject({ status: "failed", failureMsg: { key: "stored.paymentFailed" } });

    const expired = await pendingPayment("cs_expired");
    await send("checkout.session.expired", "cs_expired");
    expect((await state(expired.id, "cs_expired")).payment).toMatchObject({ status: "failed", failureMsg: { key: "stored.checkoutExpired" } });

    const paid = await pendingPayment("cs_paid");
    await send("checkout.session.completed", "cs_paid", { payment_status: "paid" });
    await send("checkout.session.expired", "cs_paid");
    expect(await state(paid.id, "cs_paid")).toMatchObject({ balance: 2500, payment: { status: "succeeded" } });
  });

  it("rejects a bad or missing signature without crediting", async () => {
    const u = await makeUser(0);
    await db.insert(payments).values({ userId: u.id, provider: "stripe", providerRef: "cs_2", amountCents: 2500 });
    const payload = completedEvent("cs_2");
    const badSig = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_wrong" });
    await expect(handleStripeWebhook(payload, badSig)).rejects.toBeInstanceOf(Stripe.errors.StripeSignatureVerificationError);
    await expect(handleStripeWebhook(payload, null)).rejects.toThrow(/Missing/);
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.balanceCents).toBe(0);
  });
});
