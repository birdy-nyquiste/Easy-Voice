import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db, withUserLock, type Queryable, type Tx } from "@/db";
import { agents, calls, phoneNumbers, users, type Agent, type Call } from "@/db/schema";
import { outcomeColumns, stored, type StoredMessage } from "@/lib/stored-text";
import { applyLedger, callChargeCents, hasSpendableBalance } from "@/server/billing/ledger";
import { voiceProvider, type AssistantStart, type CallEvent } from "@/server/telnyx";
import { currentTimeText, readBehavior } from "@/lib/agent-settings";
import { OUTBOUND_GREETING, variableDefaults } from "@/server/agents";
import { elevenLabsKeyUsable } from "@/server/elevenlabs-keys";
import { isElevenLabsVoice } from "@/server/telnyx/stock-voices";
import { withWebhookDedupe } from "@/server/webhooks";
import { fetchCallResultsSoon } from "./results";
import { callRef, failedCallFields, hasOtherActiveCall } from "./state";

/**
 * Process one provider call event. Safe to call repeatedly with the same
 * event: dedupe by provider event id, and every state change is guarded.
 */
export async function handleCallEvent(event: CallEvent): Promise<void> {
  if (event.type === "other") return;
  await withWebhookDedupe("telnyx", event.id, event.rawType, async () => {
    switch (event.type) {
      case "call.initiated":
        return onInitiated(event);
      case "call.answered":
        return onAnswered(event);
      case "call.hangup":
        return onHangup(event);
      case "call.recording.saved":
        return onRecordingSaved(event);
      case "call.conversation.created":
        return onConversationCreated(event);
      case "call.conversation.start_failed":
        return onAssistantStartFailed(event);
      case "call.cost":
        return onCallCost(event);
    }
  });
}

async function findCall(event: CallEvent): Promise<Call | undefined> {
  if (event.clientState) {
    const [byState] = await db.select().from(calls).where(eq(calls.id, event.clientState));
    if (byState) return byState;
  }
  if (event.callControlId) {
    const [byCcid] = await db.select().from(calls).where(eq(calls.providerCallControlId, event.callControlId));
    if (byCcid) return byCcid;
  }
  // call.recording.saved carries neither call_control_id nor (reliably) client_state.
  if (event.callSessionId) {
    const [bySession] = await db.select().from(calls).where(eq(calls.providerCallSessionId, event.callSessionId));
    return bySession;
  }
  return undefined;
}

function assistantStart(agent: Agent, call: Call): AssistantStart {
  const outbound = call.direction === "outbound";
  return {
    assistantId: agent.providerAssistantId!,
    voiceRef: agent.voiceRef,
    variables: {
      ...variableDefaults(agent),
      ...call.variables,
      call_direction: call.direction,
      call_goal: call.goal ?? "",
      // Callers without caller ID are stored as "unknown"; the agent gets nothing rather than that word.
      contact_number: outbound ? call.toNumber : call.fromNumber.startsWith("+") ? call.fromNumber : "",
      current_time: currentTimeText(readBehavior(agent.behavior).timeZone, agent.language),
    },
    // Inbound calls use the agent's stored greeting (which already includes the recording notice).
    greetingOverride: outbound ? OUTBOUND_GREETING[agent.language] : undefined,
  };
}

type InboundDecision =
  | { action: "answer"; call: Call; agent: Agent }
  | { action: "reject"; call: Call; cause: "CALL_REJECTED" | "USER_BUSY" };

/** Provider ids an outbound call doesn't have yet (its dial response was lost or not stored), from one of its events. */
function missingIds(call: Call, e: CallEvent): Partial<Call> {
  const ids: Partial<Call> = {};
  if (!call.providerCallControlId && e.callControlId) ids.providerCallControlId = e.callControlId;
  if (!call.providerCallSessionId && e.callSessionId) ids.providerCallSessionId = e.callSessionId;
  return ids;
}

/**
 * An outbound call we ended ourselves (its dial seemed to fail) that the provider placed after all:
 * hang it up, or the callee is left in silence. Only a processed hangup sets hangupCause, so without
 * one the provider never told us the call ended.
 */
async function hangUpIfEndedHere(call: Call, e: CallEvent): Promise<boolean> {
  if (call.direction !== "outbound" || !call.endedAt || call.hangupCause || !e.callControlId) return false;
  // Not retried by failing the webhook: a call that is already gone would fail every retry.
  await voiceProvider().hangup(e.callControlId).catch((err) => console.error("hangup of a call ended here failed", call.id, err));
  return true;
}

async function onInitiated(e: CallEvent) {
  if (e.direction !== "inbound") {
    const call = await findCall(e);
    if (!call) return;
    // Stored even on a call we ended, so its recording (if any) is found and purged.
    const ids = missingIds(call, e);
    if (Object.keys(ids).length) await db.update(calls).set(ids).where(eq(calls.id, call.id));
    await hangUpIfEndedHere(call, e);
    return;
  }
  const callControlId = e.callControlId;
  if (!callControlId || !e.to) return;

  const [num] = await db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.e164, e.to), eq(phoneNumbers.status, "active")));
  if (!num) {
    await voiceProvider().reject(callControlId, "CALL_REJECTED");
    return;
  }

  // Checked before taking the lock: it may ask ElevenLabs, and the lock holds a transaction open.
  const voiceUsable = await agentVoiceUsable(num.userId, num.agentId);

  // Admission runs under the user's lock so two simultaneous calls can't both pass the busy check.
  const decision = await withUserLock(num.userId, async (tx): Promise<InboundDecision | null> => {
    const [created] = await tx
      .insert(calls)
      .values({
        userId: num.userId,
        agentId: num.agentId,
        phoneNumberId: num.id,
        direction: "inbound",
        fromNumber: e.from ?? "unknown",
        toNumber: e.to!,
        providerCallControlId: callControlId,
        providerCallSessionId: e.callSessionId,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      // Redelivery after a failed answer/reject command: re-issue the same decision.
      const [existing] = await tx.select().from(calls).where(eq(calls.providerCallControlId, callControlId));
      if (!existing || existing.endedAt) return null;
      if (existing.status === "rejected") return { action: "reject", call: existing, cause: "CALL_REJECTED" };
      if (existing.status !== "initiated") return null;
      const [agent] = existing.agentId ? await tx.select().from(agents).where(eq(agents.id, existing.agentId)) : [];
      return agent?.providerAssistantId ? { action: "answer", call: existing, agent } : null;
    }
    const check = await checkInbound(tx, created, num.agentId, voiceUsable);
    if ("outcome" in check) {
      await tx.update(calls).set({ status: "rejected", ...outcomeColumns(check.outcome) }).where(eq(calls.id, created.id));
      return { action: "reject", call: created, cause: check.cause };
    }
    return { action: "answer", call: created, agent: check.agent };
  });
  if (!decision) return;

  if (decision.action === "reject") {
    await voiceProvider().reject(callControlId, decision.cause);
  } else {
    // Answer + start assistant in one command (avoids dead air). Telnyx dedupes by command_id on retry.
    await voiceProvider().answer(callControlId, decision.call.id, assistantStart(decision.agent, decision.call));
  }
}

/** False when the agent speaks with the user's own ElevenLabs voice and ElevenLabs rejects their key. */
async function agentVoiceUsable(userId: string, agentId: string | null): Promise<boolean> {
  if (!agentId) return true;
  const [agent] = await db.select({ voiceRef: agents.voiceRef }).from(agents).where(eq(agents.id, agentId));
  return !agent || !isElevenLabsVoice(agent.voiceRef) || elevenLabsKeyUsable(userId);
}

async function checkInbound(
  q: Queryable,
  call: Call,
  agentId: string | null,
  voiceUsable: boolean,
): Promise<{ agent: Agent } | { outcome: StoredMessage; cause: "CALL_REJECTED" | "USER_BUSY" }> {
  const [user] = await q.select().from(users).where(eq(users.id, call.userId));
  if (!hasSpendableBalance(user.balanceCents)) {
    return { outcome: stored("outcomeBalanceEmpty"), cause: "CALL_REJECTED" };
  }
  if (!agentId) return { outcome: stored("outcomeNoAgent"), cause: "CALL_REJECTED" };
  const [agent] = await q.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.deletedAt || agent.status !== "ready" || !agent.providerAssistantId) {
    return { outcome: stored("outcomeAgentNotReady"), cause: "CALL_REJECTED" };
  }
  if (!voiceUsable) {
    return { outcome: stored("outcomeKeyRejected"), cause: "CALL_REJECTED" };
  }
  if (await hasOtherActiveCall(call.userId, call.id, q)) {
    return { outcome: stored("outcomeBusy"), cause: "USER_BUSY" };
  }
  return { agent };
}

async function onAnswered(e: CallEvent) {
  const found = await findCall(e);
  if (!found || (await hangUpIfEndedHere(found, e))) return;
  const callControlId = found.providerCallControlId ?? e.callControlId;
  if (!callControlId) return;
  // Conditional, so a duplicate or a hangup processed at the same moment can't be overwritten.
  const [call] = await db
    .update(calls)
    .set({ status: "answered", answeredAt: e.occurredAt, ...missingIds(found, e) })
    .where(and(eq(calls.id, found.id), eq(calls.status, "initiated"), isNull(calls.endedAt)))
    .returning();
  if (!call) {
    // Deliveries can arrive out of order: the hangup may already have recorded the call as never connected.
    await billLateAnswer(found.id, e.occurredAt);
    return;
  }
  if (call.direction === "inbound") return; // assistant already started by answer

  const [agent] = call.agentId ? await db.select().from(agents).where(eq(agents.id, call.agentId)) : [];
  if (!agent?.providerAssistantId) {
    await endWithoutCharge(call, stored("outcomeAgentUnavailable"));
    return;
  }
  try {
    const { conversationId } = await voiceProvider().startAssistant(callControlId, assistantStart(agent, call));
    if (conversationId) {
      await db.update(calls).set({ providerConversationId: conversationId }).where(eq(calls.id, call.id));
    }
  } catch (err) {
    console.error("startAssistant failed", call.id, err);
    await endWithoutCharge(call, stored("outcomeAgentFailed"));
  }
}

async function onConversationCreated(e: CallEvent) {
  const call = await findCall(e);
  if (!call || !e.conversationId || call.providerConversationId) return;
  await db.update(calls).set({ providerConversationId: e.conversationId }).where(eq(calls.id, call.id));
}

async function onAssistantStartFailed(e: CallEvent) {
  const call = await findCall(e);
  if (!call || call.endedAt) return;
  console.error("Assistant failed to start", call.id, e.failureReason);
  // The call stays answered on the provider side; hang up so the caller isn't left in silence.
  await endWithoutCharge(call, stored("outcomeAgentFailed"));
}

/** Our side failed after the call connected: hang up and waive the charge. */
async function endWithoutCharge(call: Call, outcome: StoredMessage) {
  await db.update(calls).set({ ...outcomeColumns(outcome), chargeWaived: true }).where(eq(calls.id, call.id));
  if (call.providerCallControlId) await voiceProvider().hangup(call.providerCallControlId);
}

/** Why a call that never connected ended, by hangup cause. The cause itself is kept only in hangupCause. */
const HANGUP_OUTCOMES: Record<string, StoredMessage> = {
  timeout: stored("outcomeNoAnswer"),
  no_answer: stored("outcomeNoAnswer"),
  user_busy: stored("outcomeLineBusy"),
  call_rejected: stored("outcomeDeclined"),
  originator_cancel: stored("outcomeCallerHungUp"),
  not_found: stored("outcomeUnreachable"),
};

function hangupOutcome(call: Call, cause: string): StoredMessage {
  // On an outbound call our side is the originator: it ending before an answer is the user hanging up.
  if (call.direction === "outbound" && (cause === "originator_cancel" || cause === "normal_clearing")) {
    return stored("outcomeCancelled");
  }
  return HANGUP_OUTCOMES[cause] ?? stored("outcomeEndedEarly");
}

const secondsBetween = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));

/** Mark a connected call completed and charge for it, once (the ledger key is per call). */
async function completeAndBill(tx: Tx, call: Call, answeredAt: Date, endedAt: Date, cause: string | null) {
  const durationSec = secondsBetween(answeredAt, endedAt);
  const charge = callChargeCents(durationSec);
  await tx
    .update(calls)
    .set({ status: "completed", answeredAt, endedAt, durationSec, billedCents: charge, hangupCause: cause, resultsFetched: false, outcome: null, outcomeMsg: null })
    .where(eq(calls.id, call.id));
  if (charge > 0) {
    await applyLedger(
      {
        userId: call.userId,
        amountCents: -charge,
        kind: "call",
        idempotencyKey: `call:${call.id}`,
        description: stored(call.direction === "inbound" ? "ledgerCallInbound" : "ledgerCallOutbound", { minutes: Math.ceil(durationSec / 60) }),
        refType: "call",
        refId: call.id,
      },
      tx,
    );
  }
}

async function onHangup(e: CallEvent) {
  const found = await findCall(e);
  if (!found || found.endedAt) return;
  // Telnyx's call.hangup has no end_time; the event time is the end.
  const endedAt = e.endTime ?? e.occurredAt;
  const cause = e.hangupCause ?? "unknown";

  // Decided on the locked row, so an answer processed at the same moment is either seen here or
  // waits and then finds the call ended (see billLateAnswer).
  const billed = await db.transaction(async (tx) => {
    const [call] = await tx.select().from(calls).where(eq(calls.id, found.id)).for("update");
    if (!call || call.endedAt) return false;

    if (call.answeredAt && call.chargeWaived) {
      await tx
        .update(calls)
        .set({ ...failedCallFields(endedAt), status: "failed", durationSec: secondsBetween(call.answeredAt, endedAt), hangupCause: cause })
        .where(eq(calls.id, call.id));
      return false;
    }
    if (call.answeredAt) {
      await completeAndBill(tx, call, call.answeredAt, endedAt, cause);
      return true;
    }
    await tx
      .update(calls)
      .set({
        ...failedCallFields(endedAt),
        status: call.status === "rejected" ? "rejected" : "failed",
        // An outcome set earlier (a rejection, a failed start) explains the call better than the hangup cause.
        ...(call.outcome ? {} : outcomeColumns(hangupOutcome(call, cause))),
        hangupCause: cause,
      })
      .where(eq(calls.id, call.id));
    return false;
  });
  if (billed) fetchCallResultsSoon(found.id);
}

/**
 * call.answered processed after call.hangup: the hangup took the call as never connected. On an
 * inbound call the conversation did happen (the assistant starts with the answer command), so bill it
 * from the answer time. An outbound assistant only starts here, so that callee heard nothing and the
 * call stays free, as do rejected calls and calls our side ended for free.
 */
async function billLateAnswer(callId: string, answeredAt: Date) {
  const billed = await db.transaction(async (tx) => {
    const [call] = await tx.select().from(calls).where(eq(calls.id, callId)).for("update");
    if (!call?.endedAt || call.answeredAt || call.direction !== "inbound" || call.status !== "failed" || call.chargeWaived) return false;
    await completeAndBill(tx, call, answeredAt, call.endedAt, call.hangupCause);
    return true;
  });
  if (billed) fetchCallResultsSoon(callId);
}

async function onRecordingSaved(e: CallEvent) {
  const call = await findCall(e);
  if (!call) return;
  const [marked] = await db
    .update(calls)
    .set({ hasRecording: true })
    .where(and(eq(calls.id, call.id), isNull(calls.purgedAt)))
    .returning({ id: calls.id });
  if (marked) return;
  // The recording was saved after the call's content was deleted (by the user or the retention
  // purge): delete it at the provider too. A failure throws, so the webhook is retried.
  const ref = callRef(call);
  if (ref) await voiceProvider().purgeCallData(ref);
}

/** Provider cost for reconciliation (SPEC §8: provider usage is recorded apart from user charges). */
async function onCallCost(e: CallEvent) {
  const call = await findCall(e);
  const usd = Number(e.totalCostUsd);
  if (!call || !Number.isFinite(usd)) return;
  await db.update(calls).set({ providerCostMicros: Math.round(usd * 1_000_000) }).where(eq(calls.id, call.id));
}
