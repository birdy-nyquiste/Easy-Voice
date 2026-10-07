import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { payments, phoneNumbers, users } from "@/db/schema";
import { UserError } from "@/lib/errors";
import { addDevCredit, completePayment, createTopup } from "@/server/billing/payments";
import { chargeNumberRenewals, purchaseNumber } from "@/server/numbers";
import { mockProvider } from "@/server/telnyx/mock";
import { makeUser, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const balance = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0].balanceCents;

describe("number purchase", () => {
  it("refuses without funds and leaves no record", async () => {
    const u = await makeUser(100);
    await expect(purchaseNumber(u, "+14155551234")).rejects.toBeInstanceOf(UserError);
    expect(await db.select().from(phoneNumbers)).toHaveLength(0);
    expect(await balance(u.id)).toBe(100);
  });

  it("charges the first month up front", async () => {
    const u = await makeUser(1000);
    const n = await purchaseNumber(u, "+14155551234");
    expect(n.status).toBe("pending");
    expect(await balance(u.id)).toBe(700);
  });

  it("refunds when the provider order fails", async () => {
    const u = await makeUser(1000);
    vi.spyOn(mockProvider, "orderNumber").mockResolvedValue({ orderId: "o1", status: "failure", failureReason: "gone" });
    const n = await purchaseNumber(u, "+14155551234");
    expect(n).toMatchObject({ status: "failed", failureReason: "gone" });
    expect(await balance(u.id)).toBe(1000);
  });

  it("enforces one number per user", async () => {
    const u = await makeUser(5000);
    await purchaseNumber(u, "+14155551234");
    await expect(purchaseNumber(u, "+14155551235")).rejects.toThrow(/up to 1/);
  });

  it("lets only one of two simultaneous purchases through", async () => {
    const u = await makeUser(5000);
    const results = await Promise.allSettled([purchaseNumber(u, "+14155551234"), purchaseNumber(u, "+14155551235")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(phoneNumbers)).toHaveLength(1);
    expect(await balance(u.id)).toBe(4700);
  });

  it("charges each renewal period once", async () => {
    const u = await makeUser(1000);
    const n = await purchaseNumber(u, "+14155551234");
    await db.update(phoneNumbers).set({ status: "active", paidThrough: new Date(Date.now() - 1000) }).where(eq(phoneNumbers.id, n.id));
    expect(await chargeNumberRenewals()).toBe(1);
    expect(await chargeNumberRenewals()).toBe(0);
    expect(await balance(u.id)).toBe(400);
  });
});

describe("dev credit", () => {
  it("credits directly outside production, as an adjustment rather than a payment", async () => {
    const u = await makeUser(0);
    await addDevCredit(u, 1000);
    expect(await balance(u.id)).toBe(1000);
    expect(await db.select().from(payments)).toHaveLength(0);
  });

  it("is refused in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const u = await makeUser(0);
      await expect(addDevCredit(u, 1000)).rejects.toThrow(/Not available/);
      expect(await balance(u.id)).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("payments", () => {
  it("never credits balance without Stripe", async () => {
    const u = await makeUser(0);
    await expect(createTopup(u, 2500)).rejects.toThrow(/aren't configured/);
    expect(await balance(u.id)).toBe(0);
  });

  it("credits a completed payment exactly once", async () => {
    const u = await makeUser(0);
    await db.insert(payments).values({ userId: u.id, provider: "stripe", providerRef: "cs_1", amountCents: 2500 });
    await completePayment("cs_1");
    await completePayment("cs_1");
    expect(await balance(u.id)).toBe(2500);
  });
});
