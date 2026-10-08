import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, withUserLock } from "@/db";
import { agents, calls, phoneNumbers, type Call, type User } from "@/db/schema";
import { UserError } from "@/lib/errors";
import { toE164US } from "@/lib/format";
import { hasSpendableBalance } from "@/server/billing/ledger";
import { MAX_CALL_GOAL_LENGTH } from "@/server/agents";
import { voiceProvider } from "@/server/telnyx";
import { callRef, failedCallFields, hasOtherActiveCall } from "./state";
import { fetchCallResults } from "./results";

export async function listUserCalls(userId: string, limit = 50) {
  return db
    .select({ call: calls, agentName: agents.name })
    .from(calls)
    .leftJoin(agents, eq(calls.agentId, agents.id))
    .where(and(eq(calls.userId, userId), isNull(calls.deletedAt)))
    .orderBy(desc(calls.createdAt))
    .limit(limit);
}

export async function getUserCall(userId: string, callId: string): Promise<Call | null> {
  const [c] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.userId, userId), isNull(calls.deletedAt)));
  if (!c) return null;
  return fetchCallResults(c);
}

export async function startOutboundCall(user: User, input: { agentId: string; to: string; goal?: string }): Promise<Call> {
  const to = toE164US(input.to);
  if (!to) throw new UserError("Enter a valid US phone number.");
  const goal = input.goal?.trim() || null;
  if (goal && goal.length > MAX_CALL_GOAL_LENGTH) {
    throw new UserError(`Keep the call goal under ${MAX_CALL_GOAL_LENGTH} characters.`);
  }
  if (!hasSpendableBalance(user.balanceCents)) throw new UserError("Your balance is empty. Top up to make calls.");

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.userId, user.id), isNull(agents.deletedAt)));
  if (!agent) throw new UserError("Agent not found.");
  if (agent.status !== "ready") throw new UserError("This agent isn't ready. Open it and save again.");

  const [from] = await db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.userId, user.id), eq(phoneNumbers.status, "active")));
  if (!from) throw new UserError("You need an active phone number to call from.");
  if (from.e164 === to) throw new UserError("You can't call your own agent number.");

  // Busy check + insert under the user's lock so two clicks can't start two calls.
  const call = await withUserLock(user.id, async (tx) => {
    if (await hasOtherActiveCall(user.id, undefined, tx)) {
      throw new UserError("Another call is in progress. Wait for it to finish.");
    }
    const [inserted] = await tx
      .insert(calls)
      .values({
        userId: user.id,
        agentId: agent.id,
        phoneNumberId: from.id,
        direction: "outbound",
        fromNumber: from.e164,
        toNumber: to,
        goal,
      })
      .returning();
    return inserted;
  });

  try {
    const res = await voiceProvider().dial({ from: from.e164, to, clientState: call.id });
    const [u] = await db
      .update(calls)
      .set({ providerCallControlId: res.callControlId, providerCallSessionId: res.callSessionId })
      .where(eq(calls.id, call.id))
      .returning();
    return u;
  } catch (err) {
    console.error("dial failed", call.id, err);
    const [u] = await db
      .update(calls)
      .set({ ...failedCallFields(new Date()), status: "failed", outcome: "The call could not be placed." })
      .where(eq(calls.id, call.id))
      .returning();
    return u;
  }
}

export async function hangupCall(userId: string, callId: string): Promise<void> {
  const call = await getUserCall(userId, callId);
  if (!call?.providerCallControlId || call.endedAt) return;
  await voiceProvider().hangup(call.providerCallControlId);
}

export async function getRecordingUrl(userId: string, callId: string): Promise<string | null> {
  const [c] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.userId, userId), isNull(calls.deletedAt)));
  const ref = c && callRef(c);
  if (!c?.hasRecording || !ref) return null;
  return voiceProvider().getRecordingUrl(ref);
}

/** User-initiated delete: removes recording at the provider and blanks content; billing rows stay. */
export async function deleteCallRecord(userId: string, callId: string): Promise<void> {
  const [c] = await db.select().from(calls).where(and(eq(calls.id, callId), eq(calls.userId, userId)));
  if (!c || c.deletedAt) throw new UserError("Call not found.");
  if (!c.endedAt) throw new UserError("Can't delete a call that's still in progress.");
  if (!(await purgeCallContent(c))) throw new UserError("Couldn't delete the recording at the provider. Try again shortly.");
  await db.update(calls).set({ deletedAt: new Date() }).where(eq(calls.id, c.id));
}

/** Delete recording, transcript and summary here and at the provider. Retries on the next run if the provider fails. */
export async function purgeCallContent(c: Call): Promise<boolean> {
  const ref = callRef(c);
  if (ref) {
    try {
      await voiceProvider().purgeCallData(ref);
    } catch (err) {
      console.error("purgeCallData failed", c.id, err);
      return false;
    }
  }
  await db
    .update(calls)
    .set({ transcript: null, summary: null, hasRecording: false, resultsFetched: true, purgedAt: new Date() })
    .where(eq(calls.id, c.id));
  return true;
}
