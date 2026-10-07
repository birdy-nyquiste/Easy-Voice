import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { ledgerEntries, users } from "@/db/schema";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";

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

/** A one-off purchase (number month, voice clone) that may later be refunded. */
export interface Purchase {
  userId: string;
  priceCents: number;
  kind: LedgerKind;
  /** Base key; the refund uses `${key}:refund`. */
  key: string;
  description: string;
  refType: string;
  refId: string;
}

/** Charge a purchase up front; an overdraft becomes a user-facing error and nothing is written. */
export async function chargePurchase(p: Purchase, insufficientMessage: string, tx?: Tx): Promise<void> {
  try {
    await applyLedger(
      {
        userId: p.userId,
        amountCents: -p.priceCents,
        kind: p.kind,
        idempotencyKey: p.key,
        description: p.description,
        refType: p.refType,
        refId: p.refId,
        requireFunds: true,
      },
      tx,
    );
  } catch (err) {
    if (err instanceof InsufficientBalanceError) throw new UserError(insufficientMessage);
    throw err;
  }
}

/** Refund a purchase exactly once. */
export async function refundPurchase(p: Purchase, description: string, tx?: Tx): Promise<void> {
  await applyLedger(
    {
      userId: p.userId,
      amountCents: p.priceCents,
      kind: "refund",
      idempotencyKey: `${p.key}:refund`,
      description,
      refType: p.refType,
      refId: p.refId,
    },
    tx,
  );
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
