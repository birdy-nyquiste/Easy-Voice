import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { payments, users } from "@/db/schema";
import { config } from "@/lib/config";
import { cancelTopup, createTopup, settleReturnedTopup } from "@/server/billing/payments";
import { makeUser, resetDb } from "./helpers";

// Stripe's API is never called from tests: the client's Checkout sessions are these stubs.
const sessions = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() }));
vi.mock("stripe", () => ({
  default: class {
    checkout = { sessions };
  },
}));

beforeEach(async () => {
  await resetDb();
  config.stripe.secretKey = "sk_test_dummy";
});
afterEach(() => {
  vi.resetAllMocks();
  config.stripe.secretKey = "";
});

const balance = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0].balanceCents;
const payment = async (ref: string) => (await db.select().from(payments).where(eq(payments.providerRef, ref)))[0];

async function pendingTopup(ref: string) {
  const u = await makeUser(0);
  const [p] = await db.insert(payments).values({ userId: u.id, provider: "stripe", providerRef: ref, amountCents: 2500 }).returning();
  return { u, p };
}

describe("starting a top-up", () => {
  it("returns to pages that can tell which checkout it was", async () => {
    const u = await makeUser(0);
    sessions.create.mockResolvedValue({ id: "cs_new", url: "https://checkout.example/cs_new" });
    expect(await createTopup(u, 2500, "en")).toBe("https://checkout.example/cs_new");
    const p = await payment("cs_new");
    expect(p).toMatchObject({ userId: u.id, amountCents: 2500, status: "pending" });
    const params = sessions.create.mock.calls[0][0];
    expect(params.success_url).toMatch(/\/account\/billing\?topup=success&session_id=\{CHECKOUT_SESSION_ID\}$/);
    expect(params.cancel_url).toMatch(new RegExp(`/account/billing\\?topup=cancelled&payment=${p.id}$`));
  });
});

describe("coming back from Checkout", () => {
  it("credits a paid checkout at once, and only once", async () => {
    const { u } = await pendingTopup("cs_paid");
    sessions.retrieve.mockResolvedValue({ id: "cs_paid", status: "complete", payment_status: "paid" });
    expect(await settleReturnedTopup(u.id, "cs_paid")).toBe("credited");
    expect(await settleReturnedTopup(u.id, "cs_paid")).toBe("succeeded");
    expect(sessions.retrieve).toHaveBeenCalledTimes(1);
    expect(await balance(u.id)).toBe(2500);
    expect((await payment("cs_paid")).status).toBe("succeeded");
  });

  it("says a bank payment is processing, without crediting it", async () => {
    const { u } = await pendingTopup("cs_bank");
    sessions.retrieve.mockResolvedValue({ id: "cs_bank", status: "complete", payment_status: "unpaid" });
    expect(await settleReturnedTopup(u.id, "cs_bank")).toBe("processing");
    expect(await balance(u.id)).toBe(0);
    expect((await payment("cs_bank")).status).toBe("pending");
  });

  it("leaves it to the webhook when Stripe can't be reached", async () => {
    const { u } = await pendingTopup("cs_down");
    sessions.retrieve.mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await settleReturnedTopup(u.id, "cs_down")).toBe("pending");
    expect(await balance(u.id)).toBe(0);
  });

  it("ignores another user's checkout", async () => {
    const { u } = await pendingTopup("cs_theirs");
    const other = await makeUser(0);
    expect(await settleReturnedTopup(other.id, "cs_theirs")).toBeNull();
    expect(sessions.retrieve).not.toHaveBeenCalled();
    expect(await balance(u.id)).toBe(0);
  });
});

describe("cancelling at Checkout", () => {
  it("closes the checkout so it isn't left pending", async () => {
    const { u, p } = await pendingTopup("cs_cancel");
    sessions.expire.mockResolvedValue({ id: "cs_cancel", status: "expired" });
    await cancelTopup(u.id, p.id);
    expect(sessions.expire).toHaveBeenCalledWith("cs_cancel");
    expect(await payment("cs_cancel")).toMatchObject({ status: "failed", failureMsg: { key: "stored.checkoutExpired" } });
  });

  it("keeps it pending if Stripe won't close it (paid in another tab)", async () => {
    const { u, p } = await pendingTopup("cs_paid_elsewhere");
    sessions.expire.mockRejectedValue(new Error("Only Checkout Sessions with a status in [open] can be expired"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await cancelTopup(u.id, p.id);
    expect((await payment("cs_paid_elsewhere")).status).toBe("pending");
  });

  it("does nothing for another user's payment or a malformed id", async () => {
    const { p } = await pendingTopup("cs_not_yours");
    const other = await makeUser(0);
    await cancelTopup(other.id, p.id);
    await cancelTopup(other.id, "not-a-uuid");
    expect(sessions.expire).not.toHaveBeenCalled();
    expect((await payment("cs_not_yours")).status).toBe("pending");
  });
});
