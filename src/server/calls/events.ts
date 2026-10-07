import "server-only";
import { and, eq } from "drizzle-orm";
import { db, withUserLock, type Queryable } from "@/db";
import { agents, calls, phoneNumbers, users, type Agent, type Call } from "@/db/schema";
import { applyLedger, callChargeCents, hasSpendableBalance } from "@/server/billing/ledger";
import { voiceProvider, type AssistantStart, type CallEvent } from "@/server/telnyx";
import { providerGreeting } from "@/server/agents";
import { withWebhookDedupe } from "@/server/webhooks";
import { fetchCallResultsSoon } from "./results";
import { failedCallFields, hasOtherActiveCall } from "./state";

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

function assistantStart(agent: Agent): AssistantStart {
  return {
    assistantId: agent.providerAssistantId!,
    greeting: providerGreeting(agent.language, agent.greeting),
    voiceRef: agent.voiceRef,
  };
}

type InboundDecision =
  | { action: "answer"; call: Call; agent: Agent }
  | { action: "reject"; call: Call; cause: "CALL_REJECTED" | "USER_BUSY" };

async function onInitiated(e: CallEvent) {
  if (e.direction !== "inbound") {
    const call = await findCall(e);
    if (call && !call.providerCallSessionId) {
      await db.update(calls).set({ providerCallSessionId: e.callSessionId }).where(eq(calls.id, call.id));
    }
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
    const check = await checkInbound(tx, created, num.agentId);
    if ("outcome" in check) {
      await tx.update(calls).set({ status: "rejected", outcome: check.outcome }).where(eq(calls.id, created.id));
      return { action: "reject", call: created, cause: check.cause };
    }
    return { action: "answer", call: created, agent: check.agent };
  });
  if (!decision) return;

  if (decision.action === "reject") {
    await voiceProvider().reject(callControlId, decision.cause);
  } else {
    // Answer + start assistant in one command (avoids dead air). Telnyx dedupes by command_id on retry.
    await voiceProvider().answer(callControlId, decision.call.id, assistantStart(decision.agent));
  }
}

async function checkInbound(
  q: Queryable,
  call: Call,
  agentId: string | null,
): Promise<{ agent: Agent } | { outcome: string; cause: "CALL_REJECTED" | "USER_BUSY" }> {
  const [user] = await q.select().from(users).where(eq(users.id, call.userId));
  if (!hasSpendableBalance(user.balanceCents)) {
    return { outcome: "Rejected: account balance is empty. Top up to receive calls.", cause: "CALL_REJECTED" };
  }
  if (!agentId) return { outcome: "Rejected: no agent is assigned to this number.", cause: "CALL_REJECTED" };
  const [agent] = await q.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.deletedAt || agent.status !== "ready" || !agent.providerAssistantId) {
    return { outcome: "Rejected: the assigned agent is not ready.", cause: "CALL_REJECTED" };
  }
  if (await hasOtherActiveCall(call.userId, call.id, q)) {
    return { outcome: "Rejected: another call was already in progress.", cause: "USER_BUSY" };
  }
  return { agent };
}

async function onAnswered(e: CallEvent) {
  const call = await findCall(e);
  if (!call || call.status !== "initiated" || !call.providerCallControlId) return;
  await db.update(calls).set({ status: "answered", answeredAt: e.occurredAt }).where(eq(calls.id, call.id));
  if (call.direction === "inbound") return; // assistant already started by answer

  const [agent] = call.agentId ? await db.select().from(agents).where(eq(agents.id, call.agentId)) : [];
  if (!agent?.providerAssistantId) {
    await endWithoutCharge(call, "Agent was unavailable; call ended. You were not charged.");
    return;
  }
  try {
    const { conversationId } = await voiceProvider().startAssistant(call.providerCallControlId, assistantStart(agent));
    if (conversationId) {
      await db.update(calls).set({ providerConversationId: conversationId }).where(eq(calls.id, call.id));
    }
  } catch (err) {
    console.error("startAssistant failed", call.id, err);
    await endWithoutCharge(call, "The agent failed to start; call ended. You were not charged.");
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
  await endWithoutCharge(call, "The agent failed to start; call ended. You were not charged.");
}

/** Our side failed after the call connected: hang up and waive the charge. */
async function endWithoutCharge(call: Call, outcome: string) {
  await db.update(calls).set({ outcome, chargeWaived: true }).where(eq(calls.id, call.id));
  if (call.providerCallControlId) await voiceProvider().hangup(call.providerCallControlId);
}

const HANGUP_OUTCOMES: Record<string, string> = {
  timeout: "No answer.",
  no_answer: "No answer.",
  user_busy: "The line was busy.",
  call_rejected: "The call was declined.",
  originator_cancel: "The caller hung up before it was answered.",
  not_found: "That number couldn't be reached.",
};

async function onHangup(e: CallEvent) {
  const call = await findCall(e);
  if (!call || call.endedAt) return;
  // Telnyx's call.hangup has no end_time; the event time is the end.
  const endedAt = e.endTime ?? e.occurredAt;
  const cause = e.hangupCause ?? "unknown";

  if (call.answeredAt && call.chargeWaived) {
    const durationSec = Math.max(0, Math.round((endedAt.getTime() - call.answeredAt.getTime()) / 1000));
    await db
      .update(calls)
      .set({ ...failedCallFields(endedAt), status: "failed", durationSec, hangupCause: cause })
      .where(eq(calls.id, call.id));
    return;
  }

  if (call.answeredAt) {
    const durationSec = Math.max(0, Math.round((endedAt.getTime() - call.answeredAt.getTime()) / 1000));
    const charge = callChargeCents(durationSec);
    await db.transaction(async (tx) => {
      await tx
        .update(calls)
        .set({ status: "completed", endedAt, durationSec, billedCents: charge, hangupCause: cause })
        .where(eq(calls.id, call.id));
      if (charge > 0) {
        await applyLedger(
          {
            userId: call.userId,
            amountCents: -charge,
            kind: "call",
            idempotencyKey: `call:${call.id}`,
            description: `${call.direction === "inbound" ? "Inbound" : "Outbound"} call, ${Math.ceil(durationSec / 60)} min`,
            refType: "call",
            refId: call.id,
          },
          tx,
        );
      }
    });
    fetchCallResultsSoon(call.id);
    return;
  }

  await db
    .update(calls)
    .set({
      ...failedCallFields(endedAt),
      status: call.status === "rejected" ? "rejected" : "failed",
      outcome: call.outcome ?? HANGUP_OUTCOMES[cause] ?? `Call ended before connecting (${cause}).`,
      hangupCause: cause,
    })
    .where(eq(calls.id, call.id));
}

async function onRecordingSaved(e: CallEvent) {
  const call = await findCall(e);
  if (!call) return;
  await db.update(calls).set({ hasRecording: true }).where(eq(calls.id, call.id));
}

/** Provider cost for reconciliation (SPEC §8: provider usage is recorded apart from user charges). */
async function onCallCost(e: CallEvent) {
  const call = await findCall(e);
  const usd = Number(e.totalCostUsd);
  if (!call || !Number.isFinite(usd)) return;
  await db.update(calls).set({ providerCostMicros: Math.round(usd * 1_000_000) }).where(eq(calls.id, call.id));
}
