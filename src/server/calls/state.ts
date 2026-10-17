import "server-only";
import { and, eq, gt, inArray, ne } from "drizzle-orm";
import { db, type Queryable } from "@/db";
import { calls, type Call } from "@/db/schema";

const STALE_CALL_MS = 4 * 60 * 60 * 1000;

/** Columns for a call that ended without a billable conversation. */
export function failedCallFields(endedAt: Date) {
  return { endedAt, durationSec: 0, billedCents: 0, resultsFetched: true } satisfies Partial<Call>;
}

/** Whether the user already has a call in flight (we allow one at a time). */
export async function hasOtherActiveCall(userId: string, exceptCallId?: string, q: Queryable = db): Promise<boolean> {
  const active = await q
    .select({ id: calls.id })
    .from(calls)
    .where(
      and(
        eq(calls.userId, userId),
        inArray(calls.status, ["initiated", "answered"]),
        exceptCallId ? ne(calls.id, exceptCallId) : undefined,
        // Ignore stale rows (a missed hangup webhook must not block the user forever).
        gt(calls.createdAt, new Date(Date.now() - STALE_CALL_MS)),
      ),
    );
  return active.length > 0;
}

/** Provider identifiers for a call; null when the call never reached the provider. */
export function callRef(call: Call) {
  if (!call.providerCallControlId) return null;
  return {
    callControlId: call.providerCallControlId,
    callSessionId: call.providerCallSessionId,
    conversationId: call.providerConversationId,
  };
}
