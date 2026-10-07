import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { ledgerEntries, users } from "@/db/schema";
import { applyLedger, callChargeCents, InsufficientBalanceError } from "@/server/billing/ledger";
import { makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const charge = (userId: string, amountCents: number, key: string, requireFunds = false) =>
  applyLedger({ userId, amountCents, kind: "adjustment", idempotencyKey: key, description: "t", requireFunds });

describe("ledger", () => {
  it("applies each idempotency key once", async () => {
    const u = await makeUser(1000);
    expect(await charge(u.id, -300, "k1")).toEqual({ applied: true, balanceCents: 700 });
    expect(await charge(u.id, -300, "k1")).toEqual({ applied: false, balanceCents: 700 });
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.balanceCents).toBe(700);
  });

  it("refuses to overdraw when requireFunds is set, without writing", async () => {
    const u = await makeUser(200);
    await expect(charge(u.id, -300, "k1", true)).rejects.toBeInstanceOf(InsufficientBalanceError);
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, u.id));
    expect(entries).toHaveLength(1); // just the seed
  });

  it("tracks when the balance went negative and clears it on top-up", async () => {
    const u = await makeUser(100);
    await charge(u.id, -300, "k1");
    let [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.balanceCents).toBe(-200);
    expect(row.negativeSince).toBeInstanceOf(Date);
    await charge(u.id, 1000, "k2");
    [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.negativeSince).toBeNull();
  });

  it("keeps the cached balance equal to the ledger sum under concurrent charges", async () => {
    const u = await makeUser(10_000);
    await Promise.all(Array.from({ length: 20 }, (_, i) => charge(u.id, -100, `c${i}`)));
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    const [{ sum }] = await db
      .select({ sum: sql<number>`sum(${ledgerEntries.amountCents})::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, u.id));
    expect(row.balanceCents).toBe(8000);
    expect(sum).toBe(8000);
  });

  it("rounds call minutes up and charges nothing for zero duration", () => {
    expect(callChargeCents(0)).toBe(0);
    expect(callChargeCents(null)).toBe(0);
    expect(callChargeCents(1)).toBe(15);
    expect(callChargeCents(60)).toBe(15);
    expect(callChargeCents(61)).toBe(30);
  });
});
