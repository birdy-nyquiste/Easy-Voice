import "server-only";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { db, withUserLock } from "@/db";
import { agents, calls, phoneNumbers, type Agent, type Call, type User } from "@/db/schema";
import { MAX_VARIABLE_VALUE_LENGTH, readVariables } from "@/lib/agent-settings";
import { UserError } from "@/lib/errors";
import { outcomeColumns, stored } from "@/lib/stored-text";
import { toE164US } from "@/lib/format";
import { isUuid } from "@/lib/uuid";
import { hasSpendableBalance } from "@/server/billing/ledger";
import { getUserAgent, MAX_CALL_GOAL_LENGTH } from "@/server/agents";
import { elevenLabsKeyUsable } from "@/server/elevenlabs-keys";
import { voiceProvider, type DialResult } from "@/server/telnyx";
import { isElevenLabsVoice } from "@/server/telnyx/stock-voices";
import { callRef, failedCallFields, hasOtherActiveCall, isCallLive, STALE_CALL_MS } from "./state";
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
  if (!isUuid(callId)) return null;
  const [c] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.userId, userId), isNull(calls.deletedAt)));
  if (!c) return null;
  return fetchCallResults(c);
}

/** The name of the call's agent, also once the agent is deleted (as the call list shows it). */
export async function callAgentName(call: Call): Promise<string | null> {
  if (!call.agentId) return null;
  const [a] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, call.agentId), eq(agents.userId, call.userId)));
  return a?.name ?? null;
}

export async function startOutboundCall(
  user: User,
  input: { agentId: string; to: string; goal?: string; variables?: Record<string, string> },
): Promise<Call> {
  const to = toE164US(input.to);
  if (!to) throw new UserError("invalidPhone");
  const goal = input.goal?.trim() || null;
  if (goal && goal.length > MAX_CALL_GOAL_LENGTH) {
    throw new UserError("goalTooLong", { max: MAX_CALL_GOAL_LENGTH });
  }
  if (!hasSpendableBalance(user.balanceCents)) throw new UserError("balanceEmptyCall");

  const agent = await getUserAgent(user.id, input.agentId);
  if (!agent) throw new UserError("agentNotFound");
  if (agent.status !== "ready") throw new UserError("agentNotReady");
  const variables = perCallVariables(agent, input.variables ?? {});
  if (isElevenLabsVoice(agent.voiceRef) && !(await elevenLabsKeyUsable(user.id))) {
    throw new UserError("agentVoiceKeyRejected");
  }

  const [from] = await db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.userId, user.id), eq(phoneNumbers.status, "active")));
  if (!from) throw new UserError("noActiveNumber");
  if (from.e164 === to) throw new UserError("cantCallOwnNumber");

  // Busy check + insert under the user's lock so two clicks can't start two calls.
  const call = await withUserLock(user.id, async (tx) => {
    if (await hasOtherActiveCall(user.id, undefined, tx)) {
      throw new UserError("callInProgress");
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
        variables,
      })
      .returning();
    return inserted;
  });

  let placed: DialResult;
  try {
    placed = await voiceProvider().dial({ from: from.e164, to, clientState: call.id });
  } catch (err) {
    console.error("dial failed", call.id, err);
    // End it so it doesn't block the next call, unless a webhook already showed it was placed (only the
    // response was lost). If it was placed after all, its later webhooks hang it up (see events.ts).
    const [failed] = await db
      .update(calls)
      .set({ ...failedCallFields(new Date()), status: "failed", ...outcomeColumns(stored("outcomeNotPlaced")) })
      // Nor over a hangup processed meanwhile, which recorded how the call really ended.
      .where(and(eq(calls.id, call.id), isNull(calls.providerCallControlId), isNull(calls.endedAt)))
      .returning();
    return failed ?? (await db.select().from(calls).where(eq(calls.id, call.id)))[0];
  }
  // The call is placed, so a failure here mustn't mark it failed or reach the user as one: its webhooks
  // fill in these ids if this write is lost.
  const ids = { providerCallControlId: placed.callControlId, providerCallSessionId: placed.callSessionId ?? null };
  try {
    const [u] = await db.update(calls).set(ids).where(eq(calls.id, call.id)).returning();
    return u;
  } catch (err) {
    console.error("storing dial ids failed", call.id, err);
    return { ...call, ...ids };
  }
}

/** Values given for the agent's ask-on-each-call variables; blank ones fall back to the default. */
function perCallVariables(agent: Agent, given: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const v of readVariables(agent.variables)) {
    const value = given[v.key]?.trim();
    if (!v.askPerCall || !value) continue;
    if (value.length > MAX_VARIABLE_VALUE_LENGTH) throw new UserError("variableValueTooLong", { key: v.key, max: MAX_VARIABLE_VALUE_LENGTH });
    out[v.key] = value;
  }
  return Object.keys(out).length ? out : null;
}

export async function hangupCall(userId: string, callId: string): Promise<void> {
  const call = await getUserCall(userId, callId);
  if (!call?.providerCallControlId || call.endedAt) return;
  await voiceProvider().hangup(call.providerCallControlId);
}

export async function getRecordingUrl(userId: string, callId: string): Promise<string | null> {
  if (!isUuid(callId)) return null;
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
  const [c] = isUuid(callId) ? await db.select().from(calls).where(and(eq(calls.id, callId), eq(calls.userId, userId))) : [];
  if (!c || c.deletedAt) throw new UserError("callNotFound");
  if (isCallLive(c)) throw new UserError("callStillLive");
  if (!(await purgeCallContent(c))) throw new UserError("recordingDeleteFailed");
  await db.update(calls).set({ deletedAt: new Date() }).where(eq(calls.id, c.id));
}

/**
 * End calls whose hangup never arrived (a lost webhook), so they stop counting as in progress and can be
 * purged and deleted. How long such a call lasted is unknown, so it isn't charged.
 */
export async function finalizeStaleCalls(now = new Date()): Promise<number> {
  const stale = await db
    .update(calls)
    .set({ ...failedCallFields(now), status: "failed", ...outcomeColumns(stored("outcomeStatusLost")) })
    .where(and(isNull(calls.endedAt), lt(calls.createdAt, new Date(now.getTime() - STALE_CALL_MS))))
    .returning({ id: calls.id });
  return stale.length;
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
