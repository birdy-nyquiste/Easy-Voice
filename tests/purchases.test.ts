import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { ledgerEntries, payments, phoneNumbers, users } from "@/db/schema";
import { config } from "@/lib/config";
import { isUsNumber, toE164US } from "@/lib/format";
import { showStored, stored } from "@/lib/stored-text";
import { UserError } from "@/lib/errors";
import { refundPurchase } from "@/server/billing/ledger";
import { addDevCredit, completePayment, createTopup, failPayment, listPayments } from "@/server/billing/payments";
import {
  chargeNumberRenewals,
  listRecentNegativeBalanceReleases,
  purchaseNumber,
  refreshPendingNumbers,
  releaseNumber,
} from "@/server/numbers";
import { mockProvider } from "@/server/telnyx/mock";
import { ProviderHttpError } from "@/server/telnyx/types";
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
    const [entry] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.kind, "number_monthly"));
    expect(entry.description).toBe("Phone number +14155551234 — first month");
    expect(showStored("zh", entry.description, entry.descriptionMsg)).toBe("电话号码 +14155551234——首月");
  });

  it("refunds when the provider order fails", async () => {
    const u = await makeUser(1000);
    vi.spyOn(mockProvider, "orderNumber").mockResolvedValue({ orderId: "o1", status: "failure", failureReason: "gone" });
    const n = await purchaseNumber(u, "+14155551234");
    expect(n).toMatchObject({ status: "failed", failureReason: "gone" });
    expect(await balance(u.id)).toBe(1000);
  });

  it("refunds what was charged, even if the price has changed since", async () => {
    const u = await makeUser(1000);
    const n = await purchaseNumber(u, "+14155551234"); // pending; charged $3.00
    const price = config.pricing.numberMonthlyCents;
    config.pricing.numberMonthlyCents = 500;
    try {
      vi.spyOn(mockProvider, "getNumberOrder").mockResolvedValue({ orderId: n.providerOrderId!, status: "failure" });
      await refreshPendingNumbers();
    } finally {
      config.pricing.numberMonthlyCents = price;
    }
    expect((await db.select().from(phoneNumbers))[0].status).toBe("failed");
    expect(await balance(u.id)).toBe(1000);
  });

  it("refunds nothing for a purchase that was never charged", async () => {
    const u = await makeUser(1000);
    const p = { userId: u.id, priceCents: 300, kind: "number_monthly" as const, key: "number:never:0", description: "x", refType: "phone_number", refId: "never" };
    await refundPurchase(p, "refund");
    expect(await balance(u.id)).toBe(1000);
  });

  it("refuses numbers that aren't ordinary US numbers, without charging", async () => {
    const u = await makeUser(1000);
    // Toll-free, Toronto, Jamaica, premium-rate.
    for (const e164 of ["+18005551234", "+14165551234", "+18765551234", "+19005551234"]) {
      await expect(purchaseNumber(u, e164)).rejects.toThrow(/Invalid US number/);
    }
    expect(await db.select().from(phoneNumbers)).toHaveLength(0);
    expect(await balance(u.id)).toBe(1000);
  });

  it("refuses a number another user holds", async () => {
    const a = await makeUser(1000);
    const b = await makeUser(1000);
    await purchaseNumber(a, "+14155551234");
    await expect(purchaseNumber(b, "+14155551234")).rejects.toThrow(/isn't available/);
    expect(await balance(b.id)).toBe(1000);
  });

  it("refunds at once when the provider refuses the order", async () => {
    const u = await makeUser(1000);
    vi.spyOn(mockProvider, "orderNumber").mockRejectedValue(new ProviderHttpError(422, "number unavailable"));
    await expect(purchaseNumber(u, "+14155551234")).rejects.toThrow(UserError);
    expect((await db.select().from(phoneNumbers))[0].status).toBe("failed");
    expect(await balance(u.id)).toBe(1000);
  });

  describe("when the order's outcome is unknown", () => {
    async function lostOrder() {
      const u = await makeUser(1000);
      vi.spyOn(mockProvider, "orderNumber").mockRejectedValue(new Error("The operation was aborted due to timeout"));
      const n = await purchaseNumber(u, "+14155551234");
      expect(n.status).toBe("pending");
      expect(await balance(u.id)).toBe(700);
      return { u, n };
    }
    const age = (id: string) => db.update(phoneNumbers).set({ createdAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(phoneNumbers.id, id));

    it("keeps it pending, then activates it once the number turns up at the provider", async () => {
      const { u, n } = await lostOrder();
      const find = vi.spyOn(mockProvider, "findNumber").mockResolvedValue("num_found");
      await refreshPendingNumbers();
      expect(find).not.toHaveBeenCalled(); // too soon: the order may still be in flight
      await age(n.id);
      await refreshPendingNumbers();
      const [row] = await db.select().from(phoneNumbers);
      expect(row).toMatchObject({ status: "active", providerNumberId: "num_found", paidThrough: expect.any(Date) });
      expect(await balance(u.id)).toBe(700);
    });

    it("refunds it if the number never turns up", async () => {
      const { u, n } = await lostOrder();
      vi.spyOn(mockProvider, "findNumber").mockResolvedValue(null);
      await age(n.id);
      await refreshPendingNumbers();
      expect((await db.select().from(phoneNumbers))[0].status).toBe("failed");
      expect(await balance(u.id)).toBe(1000);
    });
  });

  it("finds a number's provider id by phone number to release it", async () => {
    const u = await makeUser(1000);
    const [n] = await db.insert(phoneNumbers).values({ userId: u.id, e164: "+14155551234", status: "active" }).returning();
    vi.spyOn(mockProvider, "findNumber").mockResolvedValue("num_old");
    const release = vi.spyOn(mockProvider, "releaseNumber");
    await releaseNumber(u.id, n.id);
    expect(release).toHaveBeenCalledWith("num_old");
    expect((await db.select().from(phoneNumbers))[0].status).toBe("released");
  });

  it("won't release a number that is still being ordered", async () => {
    const u = await makeUser(1000);
    const n = await purchaseNumber(u, "+14155551234");
    const release = vi.spyOn(mockProvider, "releaseNumber");
    await expect(releaseNumber(u.id, n.id)).rejects.toThrow(/not found/);
    expect(release).not.toHaveBeenCalled();
    expect((await db.select().from(phoneNumbers))[0].status).toBe("pending"); // still polled, so it activates
  });

  it("lists numbers we released for a negative balance, but not ones the user released", async () => {
    const u = await makeUser(1000);
    const [ours, theirs] = await db
      .insert(phoneNumbers)
      .values([
        { userId: u.id, e164: "+14155551234", status: "active", providerNumberId: "num_1" },
        { userId: u.id, e164: "+14155551235", status: "active", providerNumberId: "num_2" },
      ])
      .returning();
    await releaseNumber(u.id, ours.id, stored("numberReleasedNegative"));
    await releaseNumber(u.id, theirs.id);
    expect((await listRecentNegativeBalanceReleases(u.id)).map((n) => n.e164)).toEqual(["+14155551234"]);
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

describe("US numbers", () => {
  it("accepts ordinary US numbers", () => {
    for (const n of ["+14155551234", "+12025550123", "+15125550100", "+18015550100", "+18565550100"]) expect(isUsNumber(n), n).toBe(true);
    expect(toE164US("(415) 555-0100")).toBe("+14155550100");
    expect(toE164US("1 202 555 0123")).toBe("+12025550123");
  });

  it("refuses toll-free, premium, service and reserved codes, and other +1 countries", () => {
    const refused = [
      "8005550100", "8885550100", "8335550100", "8805550100", // toll-free, incl. reserved 88X
      "9005550100", "4115550100", "2005550100", "3955550100", // premium, N11, N00, X9X
      "4154110100", "4159760100", "4151230100", // N11 exchange, 976 premium exchange, exchange starting 1
      "0415550100", "1415550100", // area code starting 0 or 1
      "6045550100", "4165550100", "5145550100", // Canada
      "8765550100", "8095550100", "2425550100", "4415550100", // Jamaica, Dominican Republic, Bahamas, Bermuda
      "7875550100", "6715550100", // Puerto Rico, Guam
    ];
    for (const n of refused) expect(toE164US(n), n).toBeNull();
    expect(toE164US("415555010")).toBeNull();
  });
});

describe("top-up limits", () => {
  it("come from config", async () => {
    const u = await makeUser(0);
    const max = config.pricing.maxTopupCents;
    config.pricing.maxTopupCents = 2000;
    try {
      await expect(createTopup(u, 2500, "en")).rejects.toThrow(/Maximum top-up is \$20\.00/);
      await expect(addDevCredit(u, 2500)).rejects.toThrow(/Invalid amount/);
    } finally {
      config.pricing.maxTopupCents = max;
    }
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
    await expect(createTopup(u, 2500, "en")).rejects.toThrow(/aren't configured/);
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

describe("failed payments", () => {
  it("records why, in English and in the viewer's language", async () => {
    const u = await makeUser(0);
    await db.insert(payments).values({ userId: u.id, provider: "stripe", providerRef: "cs_expired", amountCents: 2500 });
    await failPayment("cs_expired", stored("checkoutExpired"));
    const [p] = await db.select().from(payments).where(eq(payments.providerRef, "cs_expired"));
    expect(p).toMatchObject({ status: "failed", failureReason: "Checkout expired" });
    expect(showStored("zh", p.failureReason!, p.failureMsg)).toBe("付款已过期");
  });

  it("aren't listed when the checkout was just left unpaid, but are when the payment failed", async () => {
    const u = await makeUser(0);
    await db.insert(payments).values([
      { userId: u.id, provider: "stripe", providerRef: "cs_abandoned", amountCents: 2500 },
      { userId: u.id, provider: "stripe", providerRef: "cs_declined", amountCents: 2500 },
      { userId: u.id, provider: "stripe", providerRef: "cs_open", amountCents: 2500 },
    ]);
    await failPayment("cs_abandoned", stored("checkoutExpired"));
    await failPayment("cs_declined", stored("paymentFailed"));
    expect((await listPayments(u.id)).map((p) => p.providerRef).sort()).toEqual(["cs_declined", "cs_open"]);
  });
});
