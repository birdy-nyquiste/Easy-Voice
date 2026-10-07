import "server-only";
import { and, eq, gt, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { agents, calls, phoneNumbers, users, webhookEvents, type Agent, type Call } from "@/db/schema";
import { applyLedger, callChargeCents, hasSpendableBalance } from "@/server/billing/ledger";
import { voiceProvider, type AssistantStart, type CallEvent } from "@/server/telnyx";
import { providerGreeting } from "@/server/agents";
import { fetchCallResultsSoon } from "./results";

/**
 * Process one provider call event. Safe to call repeatedly with the same
 * event: dedupe by provider event id, and every state change is guarded.
 */
export async function handleCallEvent(event: CallEvent): Promise<void> {
  if (event.type === "other") return;
  const [fresh] = await db
    .insert(webhookEvents)
    .values({ provider: "telnyx", eventId: event.id, eventType: event.rawType })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (!fresh) return; // duplicate delivery

  try {
    switch (event.type) {
      case "call.initiated":
        return await onInitiated(event);
      case "call.answered":
        return await onAnswered(event);
      case "call.hangup":
        return await onHangup(event);
      case "call.recording.saved":
        return await onRecordingSaved(event);
      case "call.conversation.created":
        return await onConversationCreated(event);
      case "call.conversation.start_failed":
        return await onAssistantStartFailed(event);
    }
  } catch (err) {
    // Let the provider retry this event.
    await db.delete(webhookEvents).where(eq(webhookEvents.id, fresh.id));
    throw err;
  }
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
    greeting: providerGreeting(agent.language as "en" | "zh", agent.greeting),
    voiceRef: agent.voiceRef,
  };
}

async function onInitiated(e: CallEvent) {
  if (e.direction !== "inbound") {
    const call = await findCall(e);
    if (call && !call.providerCallSessionId) {
      await db.update(calls).set({ providerCallSessionId: e.callSessionId }).where(eq(calls.id, call.id));
    }
    return;
  }
  if (!e.callControlId || !e.to) return;

  const [num] = await db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.e164, e.to), eq(phoneNumbers.status, "active")));
  if (!num) {
    await voiceProvider().reject(e.callControlId, "CALL_REJECTED");
    return;
  }

  const [call] = await db
    .insert(calls)
    .values({
      userId: num.userId,
      agentId: num.agentId,
      phoneNumberId: num.id,
      direction: "inbound",
      fromNumber: e.from ?? "unknown",
      toNumber: e.to,
      providerCallControlId: e.callControlId,
      providerCallSessionId: e.callSessionId,
    })
    .onConflictDoNothing()
    .returning();
  if (!call) return;

  const check = await checkInbound(call, num.agentId);
  if ("outcome" in check) {
    await db.update(calls).set({ status: "rejected", outcome: check.outcome }).where(eq(calls.id, call.id));
    await voiceProvider().reject(e.callControlId, check.cause);
    return;
  }
  // Answer + start assistant in one command (avoids dead air between the two).
  await voiceProvider().answer(e.callControlId, call.id, assistantStart(check.agent));
}

async function checkInbound(
  call: Call,
  agentId: string | null,
): Promise<{ agent: Agent } | { outcome: string; cause: "CALL_REJECTED" | "USER_BUSY" }> {
  const [user] = await db.select().from(users).where(eq(users.id, call.userId));
  if (!hasSpendableBalance(user.balanceCents)) {
    return { outcome: "Rejected: account balance is empty. Top up to receive calls.", cause: "CALL_REJECTED" };
  }
  if (!agentId) return { outcome: "Rejected: no agent is assigned to this number.", cause: "CALL_REJECTED" };
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.deletedAt || agent.status !== "ready" || !agent.providerAssistantId) {
    return { outcome: "Rejected: the assigned agent is not ready.", cause: "CALL_REJECTED" };
  }
  if (await hasOtherActiveCall(call.userId, call.id)) {
    return { outcome: "Rejected: another call was already in progress.", cause: "USER_BUSY" };
  }
  return { agent };
}

const STALE_CALL_MS = 4 * 60 * 60 * 1000;

export async function hasOtherActiveCall(userId: string, exceptCallId?: string): Promise<boolean> {
  const active = await db
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

async function onAnswered(e: CallEvent) {
  const call = await findCall(e);
  if (!call || call.status !== "initiated" || !call.providerCallControlId) return;
  await db.update(calls).set({ status: "answered", answeredAt: e.occurredAt }).where(eq(calls.id, call.id));
  if (call.direction === "inbound") return; // assistant already started by answer

  const [agent] = call.agentId ? await db.select().from(agents).where(eq(agents.id, call.agentId)) : [];
  if (!agent?.providerAssistantId) {
    await endWithOutcome(call, "Agent was unavailable; call ended.");
    return;
  }
  try {
    const { conversationId } = await voiceProvider().startAssistant(call.providerCallControlId, assistantStart(agent));
    if (conversationId) {
      await db.update(calls).set({ providerConversationId: conversationId }).where(eq(calls.id, call.id));
    }
  } catch (err) {
    console.error("startAssistant failed", call.id, err);
    await endWithOutcome(call, "The agent failed to start; call ended.");
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
  await endWithOutcome(call, "The agent failed to start; call ended.");
}

async function endWithOutcome(call: Call, outcome: string) {
  await db.update(calls).set({ outcome }).where(eq(calls.id, call.id));
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

  if (call.answeredAt) {
    const durationSec = Math.max(0, Math.round((endedAt.getTime() - call.answeredAt.getTime()) / 1000));
    const charge = callChargeCents(durationSec);
    await db.transaction(async (tx) => {
      await tx
        .update(calls)
        .set({ status: "completed", endedAt, durationSec, billedCents: charge, hangupCause: e.hangupCause })
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

  const cause = e.hangupCause ?? "unknown";
  await db
    .update(calls)
    .set({
      status: call.status === "rejected" ? "rejected" : "failed",
      outcome: call.outcome ?? HANGUP_OUTCOMES[cause] ?? `Call ended before connecting (${cause}).`,
      endedAt,
      durationSec: 0,
      billedCents: 0,
      hangupCause: cause,
      resultsFetched: true,
    })
    .where(eq(calls.id, call.id));
}

async function onRecordingSaved(e: CallEvent) {
  const call = await findCall(e);
  if (!call) return;
  await db.update(calls).set({ hasRecording: true }).where(eq(calls.id, call.id));
}
