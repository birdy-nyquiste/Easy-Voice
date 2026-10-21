import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, withUserLock } from "@/db";
import { agents, calls, phoneNumbers, type Agent, type Call, type User } from "@/db/schema";
import { MAX_VARIABLE_VALUE_LENGTH, readVariables } from "@/lib/agent-settings";
import { UserError } from "@/lib/errors";
import { outcomeColumns, stored } from "@/lib/stored-text";
import { toE164US } from "@/lib/format";
import { hasSpendableBalance } from "@/server/billing/ledger";
import { MAX_CALL_GOAL_LENGTH } from "@/server/agents";
import { elevenLabsKeyUsable } from "@/server/elevenlabs-keys";
import { voiceProvider } from "@/server/telnyx";
import { isElevenLabsVoice } from "@/server/telnyx/stock-voices";
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

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.userId, user.id), isNull(agents.deletedAt)));
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
      .set({ ...failedCallFields(new Date()), status: "failed", ...outcomeColumns(stored("outcomeNotPlaced")) })
      .where(eq(calls.id, call.id))
      .returning();
    return u;
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
  if (!c || c.deletedAt) throw new UserError("callNotFound");
  if (!c.endedAt) throw new UserError("callStillLive");
  if (!(await purgeCallContent(c))) throw new UserError("recordingDeleteFailed");
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
