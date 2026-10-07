import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { calls, payments, users } from "@/db/schema";
import { config } from "@/lib/config";
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
