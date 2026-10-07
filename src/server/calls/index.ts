import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, calls, phoneNumbers, type Call, type User } from "@/db/schema";
import { UserError } from "@/lib/errors";
import { toE164US } from "@/lib/format";
import { hasSpendableBalance } from "@/server/billing/ledger";
import { voiceProvider } from "@/server/telnyx";
import { hasOtherActiveCall } from "./events";
import { callRef, fetchCallResults } from "./results";

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

export async function startOutboundCall(user: User, input: { agentId: string; to: string }): Promise<Call> {
  const to = toE164US(input.to);
  if (!to) throw new UserError("Enter a valid US phone number.");
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
  if (await hasOtherActiveCall(user.id)) throw new UserError("Another call is in progress. Wait for it to finish.");

  const [call] = await db
    .insert(calls)
    .values({
      userId: user.id,
      agentId: agent.id,
      phoneNumberId: from.id,
      direction: "outbound",
      fromNumber: from.e164,
      toNumber: to,
    })
    .returning();

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
      .set({ status: "failed", outcome: "The call could not be placed.", endedAt: new Date(), durationSec: 0, billedCents: 0, resultsFetched: true })
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
  if (!c?.hasRecording || !c.providerCallControlId) return null;
  return voiceProvider().getRecordingUrl(callRef(c));
}

/** User-initiated delete: removes recording at the provider and blanks content; billing rows stay. */
export async function deleteCallRecord(userId: string, callId: string): Promise<void> {
  const [c] = await db.select().from(calls).where(and(eq(calls.id, callId), eq(calls.userId, userId)));
  if (!c || c.deletedAt) throw new UserError("Call not found.");
  if (!c.endedAt) throw new UserError("Can't delete a call that's still in progress.");
  await purgeCallContent(c);
  await db.update(calls).set({ deletedAt: new Date() }).where(eq(calls.id, c.id));
}

export async function purgeCallContent(c: Call): Promise<void> {
  if (c.hasRecording && c.providerCallControlId) {
    try {
      await voiceProvider().deleteRecordings(callRef(c));
    } catch (err) {
      console.error("deleteRecordings failed", c.id, err);
      return; // keep hasRecording so the next purge retries
    }
  }
  await db.update(calls).set({ transcript: null, summary: null, hasRecording: false }).where(eq(calls.id, c.id));
}
