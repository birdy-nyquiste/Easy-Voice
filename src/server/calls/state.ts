import "server-only";
import { and, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { db, type Queryable } from "@/db";
import { calls, type Call } from "@/db/schema";

/**
 * Well past the longest call (agents end calls after at most 30 minutes): a call with no hangup by then
 * lost its hangup webhook, and finalizeStaleCalls ends it.
 */
export const STALE_CALL_MS = 4 * 60 * 60 * 1000;

/** Whether a call may still be in progress. */
export function isCallLive(call: Pick<Call, "endedAt" | "createdAt">, now = Date.now()): boolean {
  return !call.endedAt && now - call.createdAt.getTime() < STALE_CALL_MS;
}

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
        isNull(calls.endedAt),
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
