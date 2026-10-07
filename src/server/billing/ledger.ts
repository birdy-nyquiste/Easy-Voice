import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { ledgerEntries, users } from "@/db/schema";
import { config } from "@/lib/config";

type LedgerKind = (typeof ledgerEntries.$inferInsert)["kind"];

export interface LedgerInput {
  userId: string;
  amountCents: number;
  kind: LedgerKind;
  idempotencyKey: string;
  description: string;
  refType?: string;
  refId?: string;
  /** Reject (without writing) if the charge would take the balance below zero. */
  requireFunds?: boolean;
}

export class InsufficientBalanceError extends Error {
  constructor(public balanceCents: number) {
    super("Insufficient balance");
  }
}

export interface LedgerResult {
  applied: boolean; // false when the idempotency key was already used
  balanceCents: number;
}

/**
 * Apply a balance change exactly once. Locks the user row so concurrent
 * charges serialize, and keeps users.balance_cents == sum(ledger).
 */
export async function applyLedger(input: LedgerInput, tx?: Tx): Promise<LedgerResult> {
  if (!Number.isInteger(input.amountCents)) throw new Error("amountCents must be an integer");
  const run = async (t: Tx): Promise<LedgerResult> => {
    const [user] = await t
      .select({ balance: users.balanceCents, negativeSince: users.negativeSince })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!user) throw new Error(`User ${input.userId} not found`);

    const [existing] = await t
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.idempotencyKey, input.idempotencyKey));
    if (existing) return { applied: false, balanceCents: user.balance };

    const balanceAfter = user.balance + input.amountCents;
    if (input.requireFunds && balanceAfter < 0) throw new InsufficientBalanceError(user.balance);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { requireFunds, ...entry } = input;
    await t.insert(ledgerEntries).values({ ...entry, balanceAfterCents: balanceAfter });
    await t
      .update(users)
      .set({
        balanceCents: balanceAfter,
        negativeSince:
          balanceAfter < 0 ? (user.negativeSince ?? sql`now()`) : null,
      })
      .where(eq(users.id, input.userId));
    return { applied: true, balanceCents: balanceAfter };
  };
  return tx ? run(tx) : db.transaction(run);
}

/** Whether a user may start billable activity (calls, purchases). */
export function hasSpendableBalance(balanceCents: number): boolean {
  return balanceCents > 0;
}

/** Billable minutes are rounded up; unanswered calls cost nothing. */
export function callChargeCents(durationSec: number | null | undefined): number {
  if (!durationSec || durationSec <= 0) return 0;
  return Math.ceil(durationSec / 60) * config.pricing.callPerMinuteCents;
}
