import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { ledgerEntries, users } from "@/db/schema";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { storedColumns, type StoredText } from "@/lib/stored-text";

type LedgerKind = (typeof ledgerEntries.$inferInsert)["kind"];

export interface LedgerInput {
  userId: string;
  amountCents: number;
  kind: LedgerKind;
  idempotencyKey: string;
  description: StoredText;
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
    const { requireFunds, description, ...entry } = input;
    const d = storedColumns(description);
    await t.insert(ledgerEntries).values({ ...entry, description: d.text, descriptionMsg: d.msg, balanceAfterCents: balanceAfter });
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
  description: StoredText;
  refType: string;
  refId: string;
}

/** Charge a purchase up front; an overdraft becomes a user-facing error and nothing is written. */
export async function chargePurchase(p: Purchase, insufficient: UserError, tx?: Tx): Promise<void> {
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
    if (err instanceof InsufficientBalanceError) throw insufficient;
    throw err;
  }
}

/**
 * Refund a purchase exactly once, for the amount actually charged: the configured price may have
 * changed since. Nothing is refunded if it was never charged.
 */
export async function refundPurchase(p: Purchase, description: StoredText, tx?: Tx): Promise<void> {
  const run = async (t: Tx) => {
    const [charge] = await t
      .select({ amountCents: ledgerEntries.amountCents })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.idempotencyKey, p.key));
    if (!charge) return;
    await applyLedger(
      {
        userId: p.userId,
        amountCents: -charge.amountCents,
        kind: "refund",
        idempotencyKey: `${p.key}:refund`,
        description,
        refType: p.refType,
        refId: p.refId,
      },
      t,
    );
  };
  return tx ? run(tx) : db.transaction(run);
}

/** Whether a user may start billable activity (calls, purchases). */
export function hasSpendableBalance(balanceCents: number): boolean {
  return balanceCents > 0;
}

/**
 * When the grace period of a balance that went negative at `negativeSince` ends: unless it is topped
 * up, the daily job's first run after this releases the user's numbers.
 */
export function negativeBalanceReleaseDate(negativeSince: Date): Date {
  return new Date(negativeSince.getTime() + config.policy.negativeBalanceReleaseDays * 24 * 60 * 60 * 1000);
}

/** Billable minutes are rounded up; unanswered calls cost nothing. */
export function callChargeCents(durationSec: number | null | undefined): number {
  if (!durationSec || durationSec <= 0) return 0;
  return Math.ceil(durationSec / 60) * config.pricing.callPerMinuteCents;
}
