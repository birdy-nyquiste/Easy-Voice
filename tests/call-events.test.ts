import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { agents, calls, ledgerEntries, users } from "@/db/schema";
import { showStored } from "@/lib/stored-text";
import { callAgentName, deleteCallRecord, startOutboundCall } from "@/server/calls";
import { handleCallEvent } from "@/server/calls/events";
import { fetchCallResults } from "@/server/calls/results";
import { isAwaitingResults, RESULTS_WAIT_MS } from "@/server/calls/state";
import { withWebhookDedupe } from "@/server/webhooks";
import { parseCallEnvelope } from "@/server/telnyx/events";
import { mockProvider } from "@/server/telnyx/mock";
import { event, makeLine, makeUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
  // Stub provider commands so the mock doesn't emit its own simulated events.
  vi.spyOn(mockProvider, "answer").mockResolvedValue();
  vi.spyOn(mockProvider, "reject").mockResolvedValue();
  vi.spyOn(mockProvider, "hangup").mockResolvedValue();
  vi.spyOn(mockProvider, "startAssistant").mockResolvedValue({ conversationId: "conv-1" });
  vi.spyOn(mockProvider, "getCallResults").mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

const inbound = (to: string, ccid = "cc-1") =>
  event("call.initiated", { callControlId: ccid, callSessionId: `sess-${ccid}`, direction: "inbound", from: "+12025550123", to });

async function callByCcid(ccid: string) {
  const [c] = await db.select().from(calls).where(eq(calls.providerCallControlId, ccid));
  return c;
}

describe("inbound calls", () => {
  it("answers with the assigned agent, bills rounded-up minutes once, and records results", async () => {
    const { user, number } = await makeLine(1000);
    await handleCallEvent(inbound(number.e164));
    const created = await callByCcid("cc-1");
    expect(created.status).toBe("initiated");
    expect(mockProvider.answer).toHaveBeenCalledWith("cc-1", created.id, {
      assistantId: "assistant-test",
      variables: { call_direction: "inbound", call_goal: "", contact_number: "+12025550123", current_time: expect.any(String) },
      greetingOverride: undefined, // inbound keeps the agent's own greeting
    });

    const t0 = new Date("2026-10-07T10:00:00Z");
    await handleCallEvent(event("call.answered", { callControlId: "cc-1", clientState: created.id, occurredAt: t0 }));
    const hangup = event("call.hangup", {
      callControlId: "cc-1",
      clientState: created.id,
      hangupCause: "normal_clearing",
      occurredAt: new Date(t0.getTime() + 61_000),
    });
    await handleCallEvent(hangup);
    await handleCallEvent(hangup); // duplicate delivery
    await handleCallEvent({ ...hangup, id: "different-id" }); // re-sent with a new id

    const done = await callByCcid("cc-1");
    expect(done).toMatchObject({ status: "completed", durationSec: 61, billedCents: 30 });
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u.balanceCents).toBe(970);
    const charges = await db.select().from(ledgerEntries).where(eq(ledgerEntries.refId, done.id));
    expect(charges).toHaveLength(1);

    // Recording webhook has no call_control_id; it's matched by session.
    await handleCallEvent(event("call.recording.saved", { callSessionId: "sess-cc-1" }));
    expect((await callByCcid("cc-1")).hasRecording).toBe(true);
  });

  it("rejects when the balance is empty and explains why", async () => {
    const { number } = await makeLine(0);
    await handleCallEvent(inbound(number.e164));
    expect(mockProvider.reject).toHaveBeenCalledWith("cc-1", "CALL_REJECTED");
    expect(mockProvider.answer).not.toHaveBeenCalled();
    const c = await callByCcid("cc-1");
    expect(c.status).toBe("rejected");
    expect(c.outcome).toMatch(/balance/);
    expect(showStored("zh", c.outcome!, c.outcomeMsg)).toBe("已拒接：账户余额已用完。充值后即可接听来电。");

    await handleCallEvent(event("call.hangup", { callControlId: "cc-1", hangupCause: "call_rejected" }));
    expect(await callByCcid("cc-1")).toMatchObject({ status: "rejected", billedCents: 0 });
  });

  it("rejects when no agent is assigned", async () => {
    const { number } = await makeLine(1000);
    await db.update((await import("@/db/schema")).phoneNumbers).set({ agentId: null });
    await handleCallEvent(inbound(number.e164));
    expect((await callByCcid("cc-1")).outcome).toMatch(/no agent/);
  });

  it("rejects a second concurrent call as busy", async () => {
    const { number } = await makeLine(1000);
    await handleCallEvent(inbound(number.e164, "cc-1"));
    await handleCallEvent(inbound(number.e164, "cc-2"));
    expect(mockProvider.reject).toHaveBeenCalledWith("cc-2", "USER_BUSY");
  });

  it("leaves contact_number empty for callers without caller ID", async () => {
    const { number } = await makeLine(1000);
    await handleCallEvent(event("call.initiated", { callControlId: "cc-anon", callSessionId: "sess-anon", direction: "inbound", to: number.e164 }));
    expect(vi.mocked(mockProvider.answer).mock.calls[0][2].variables.contact_number).toBe("");
  });

  it("rejects calls to numbers we don't own without creating a record", async () => {
    await makeUser(1000);
    await handleCallEvent(inbound("+19995550000", "cc-x"));
    expect(mockProvider.reject).toHaveBeenCalledWith("cc-x", "CALL_REJECTED");
    expect(await callByCcid("cc-x")).toBeUndefined();
  });

  it("re-answers when Telnyx redelivers after a failed answer command", async () => {
    const { number } = await makeLine(1000);
    vi.mocked(mockProvider.answer).mockRejectedValueOnce(new Error("telnyx 503"));
    const initiated = inbound(number.e164);
    await expect(handleCallEvent(initiated)).rejects.toThrow("telnyx 503");
    await handleCallEvent(initiated); // same event id, redelivered
    const c = await callByCcid("cc-1");
    expect(mockProvider.answer).toHaveBeenCalledTimes(2);
    expect(mockProvider.answer).toHaveBeenLastCalledWith("cc-1", c.id, expect.objectContaining({ assistantId: "assistant-test" }));
  });

  it("re-issues a reject when Telnyx redelivers after a failed reject command", async () => {
    const { number } = await makeLine(0);
    vi.mocked(mockProvider.reject).mockRejectedValueOnce(new Error("telnyx 503"));
    const initiated = inbound(number.e164);
    await expect(handleCallEvent(initiated)).rejects.toThrow();
    await handleCallEvent(initiated);
    expect(mockProvider.reject).toHaveBeenCalledTimes(2);
    expect(mockProvider.answer).not.toHaveBeenCalled();
  });

  it("admits only one of two simultaneous inbound calls", async () => {
    const { number } = await makeLine(1000);
    await Promise.all([handleCallEvent(inbound(number.e164, "cc-a")), handleCallEvent(inbound(number.e164, "cc-b"))]);
    expect(mockProvider.answer).toHaveBeenCalledTimes(1);
    expect(mockProvider.reject).toHaveBeenCalledTimes(1);
    expect(mockProvider.reject).toHaveBeenCalledWith(expect.any(String), "USER_BUSY");
  });

  it("records the provider cost without charging the user for it", async () => {
    const { user, number } = await makeLine(1000);
    await handleCallEvent(inbound(number.e164));
    await handleCallEvent(event("call.cost", { callControlId: "cc-1", totalCostUsd: "0.0106" }));
    expect((await callByCcid("cc-1")).providerCostMicros).toBe(10_600);
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u.balanceCents).toBe(1000);
  });

  it("hangs up when the assistant fails to start", async () => {
    const { number } = await makeLine(1000);
    await handleCallEvent(inbound(number.e164));
    const c = await callByCcid("cc-1");
    await handleCallEvent(event("call.conversation.start_failed", { callControlId: "cc-1", clientState: c.id, failureReason: "service_error" }));
    expect(mockProvider.hangup).toHaveBeenCalledWith("cc-1");
    expect((await callByCcid("cc-1")).outcome).toMatch(/failed to start/);
  });

  it("says the caller hung up when they cancel before the call is answered", async () => {
    const { number } = await makeLine(1000);
    await handleCallEvent(inbound(number.e164));
    await handleCallEvent(event("call.hangup", { callControlId: "cc-1", hangupCause: "originator_cancel" }));
    expect(await callByCcid("cc-1")).toMatchObject({ status: "failed", outcomeMsg: { key: "stored.outcomeCallerHungUp" } });
  });

  it("matches a call by its call control id when client_state isn't one of our ids", async () => {
    const { number } = await makeLine(1000);
    await handleCallEvent(inbound(number.e164));
    const e = parseCallEnvelope({
      data: {
        id: "evt-foreign-state",
        event_type: "call.hangup",
        occurred_at: new Date().toISOString(),
        payload: { call_control_id: "cc-1", hangup_cause: "originator_cancel", client_state: Buffer.from("not-a-call-id").toString("base64") },
      },
    });
    expect(e.clientState).toBeUndefined();
    await handleCallEvent(e);
    expect((await callByCcid("cc-1")).status).toBe("failed");
  });

  it("doesn't charge for a call whose agent failed to start", async () => {
    const { user, number } = await makeLine(1000);
    await handleCallEvent(inbound(number.e164));
    const c = await callByCcid("cc-1");
    const t0 = new Date("2026-10-07T10:00:00Z");
    await handleCallEvent(event("call.answered", { callControlId: "cc-1", clientState: c.id, occurredAt: t0 }));
    await handleCallEvent(event("call.conversation.start_failed", { callControlId: "cc-1", clientState: c.id }));
    await handleCallEvent(event("call.hangup", { callControlId: "cc-1", clientState: c.id, occurredAt: new Date(t0.getTime() + 20_000) }));
    expect(await callByCcid("cc-1")).toMatchObject({ status: "failed", billedCents: 0, durationSec: 20 });
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u.balanceCents).toBe(1000);
  });
});

describe("webhook transport", () => {
  it("mock mode refuses webhooks over HTTP (they would be unsigned)", async () => {
    await expect(mockProvider.parseWebhook("{}", new Headers())).rejects.toThrow(/does not accept/);
  });
});

describe("outbound calls", () => {
  it("records an unanswered call as failed and free", async () => {
    const { user, agent, number } = await makeLine(1000);
    const [c] = await db
      .insert(calls)
      .values({ userId: user.id, agentId: agent.id, phoneNumberId: number.id, direction: "outbound", fromNumber: number.e164, toNumber: "+14155550000", providerCallControlId: "cc-out" })
      .returning();
    await handleCallEvent(event("call.hangup", { callControlId: "cc-out", clientState: c.id, hangupCause: "timeout" }));
    const ended = await callByCcid("cc-out");
    expect(ended).toMatchObject({ status: "failed", outcome: "No answer.", billedCents: 0 });
    expect(showStored("zh", ended.outcome!, ended.outcomeMsg)).toBe("无人接听。");
  });

  it("says an outbound call hung up while ringing was cancelled, not that the caller hung up", async () => {
    const { user, agent, number } = await makeLine(1000);
    for (const cause of ["originator_cancel", "normal_clearing"]) {
      const ccid = `cc-${cause}`;
      const [c] = await db
        .insert(calls)
        .values({ userId: user.id, agentId: agent.id, phoneNumberId: number.id, direction: "outbound", fromNumber: number.e164, toNumber: "+14155550000", providerCallControlId: ccid })
        .returning();
      await handleCallEvent(event("call.hangup", { callControlId: ccid, clientState: c.id, hangupCause: cause }));
      expect(await callByCcid(ccid)).toMatchObject({ status: "failed", outcome: "The call was cancelled before it was answered.", hangupCause: cause });
    }
  });

  it("keeps an unexplained hangup cause out of the outcome", async () => {
    const { user, agent, number } = await makeLine(1000);
    const [c] = await db
      .insert(calls)
      .values({ userId: user.id, agentId: agent.id, phoneNumberId: number.id, direction: "outbound", fromNumber: number.e164, toNumber: "+14155550000", providerCallControlId: "cc-out" })
      .returning();
    await handleCallEvent(event("call.hangup", { callControlId: "cc-out", clientState: c.id, hangupCause: "unspecified" }));
    const ended = await callByCcid("cc-out");
    expect(ended).toMatchObject({ outcome: "Call ended before connecting.", hangupCause: "unspecified" });
    expect(showStored("ja", ended.outcome!, ended.outcomeMsg)).toBe("接続前に通話が終了しました。");
  });

  it("names the call's agent even after the agent is deleted", async () => {
    const { user, agent, number } = await makeLine(1000);
    const [c] = await db
      .insert(calls)
      .values({ userId: user.id, agentId: agent.id, phoneNumberId: number.id, direction: "outbound", fromNumber: number.e164, toNumber: "+14155550000", status: "completed", endedAt: new Date() })
      .returning();
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, agent.id));
    expect(await callAgentName(c)).toBe("Test agent");
  });

  it("starts the assistant with the call's goal and an outbound greeting", async () => {
    const { user, agent, number } = await makeLine(1000);
    const [c] = await db
      .insert(calls)
      .values({ userId: user.id, agentId: agent.id, phoneNumberId: number.id, direction: "outbound", fromNumber: number.e164, toNumber: "+14155550100", providerCallControlId: "cc-out", goal: "Move my Thursday appointment" })
      .returning();
    await handleCallEvent(event("call.answered", { callControlId: "cc-out", clientState: c.id }));
    expect(mockProvider.startAssistant).toHaveBeenCalledWith("cc-out", {
      assistantId: "assistant-test",
      variables: {
        call_direction: "outbound",
        call_goal: "Move my Thursday appointment",
        contact_number: "+14155550100",
        current_time: expect.any(String),
      },
      greetingOverride: "Hi, this is an AI assistant calling. This call may be recorded.",
    });
    expect(await callByCcid("cc-out")).toMatchObject({ status: "answered", providerConversationId: "conv-1" });
  });

  it("fills in the agent's variables, with this call's values taking precedence, and the time in its zone", async () => {
    const { user, agent, number } = await makeLine(1000);
    await db
      .update(agents)
      .set({
        behavior: { timeZone: "Asia/Tokyo" },
        variables: [
          { key: "owner_name", value: "Alex", askPerCall: false },
          { key: "callback_number", value: "+12025550199", askPerCall: true },
        ],
      })
      .where(eq(agents.id, agent.id));
    const [c] = await db
      .insert(calls)
      .values({ userId: user.id, agentId: agent.id, phoneNumberId: number.id, direction: "outbound", fromNumber: number.e164, toNumber: "+14155550100", providerCallControlId: "cc-out", variables: { callback_number: "+12025550111" } })
      .returning();
    await handleCallEvent(event("call.answered", { callControlId: "cc-out", clientState: c.id }));
    const vars = vi.mocked(mockProvider.startAssistant).mock.calls[0][1].variables;
    expect(vars).toMatchObject({ owner_name: "Alex", callback_number: "+12025550111", call_direction: "outbound" });
    expect(vars.current_time).toMatch(/GMT\+9/);
  });
});

describe("outbound calls that go wrong", () => {
  const balance = async (userId: string) => (await db.select().from(users).where(eq(users.id, userId)))[0].balanceCents;
  async function outboundRow(line: Awaited<ReturnType<typeof makeLine>>) {
    const [c] = await db
      .insert(calls)
      .values({ userId: line.user.id, agentId: line.agent.id, phoneNumberId: line.number.id, direction: "outbound", fromNumber: line.number.e164, toNumber: "+14155550100", providerCallControlId: "cc-out" })
      .returning();
    return c;
  }

  it("ends a call that couldn't be placed, so it doesn't block the next one", async () => {
    const { user, agent } = await makeLine(1000);
    vi.spyOn(mockProvider, "dial").mockRejectedValueOnce(new Error("telnyx 503"));
    const failed = await startOutboundCall(user, { agentId: agent.id, to: "+14155550100" });
    expect(failed).toMatchObject({ status: "failed", outcome: "The call could not be placed.", endedAt: expect.any(Date), billedCents: 0 });
    vi.spyOn(mockProvider, "dial").mockResolvedValueOnce({ callControlId: "cc-next", callSessionId: "sess-next" });
    expect((await startOutboundCall(user, { agentId: agent.id, to: "+14155550100" })).providerCallControlId).toBe("cc-next");
  });

  it("hangs up a call that was placed after all when its dial seemed to fail", async () => {
    const { user, agent } = await makeLine(1000);
    vi.spyOn(mockProvider, "dial").mockRejectedValueOnce(new Error("timeout"));
    const failed = await startOutboundCall(user, { agentId: agent.id, to: "+14155550100" });
    expect(failed).toMatchObject({ status: "failed", providerCallControlId: null });

    await handleCallEvent(event("call.initiated", { callControlId: "cc-late", callSessionId: "sess-late", direction: "outbound", clientState: failed.id }));
    expect(mockProvider.hangup).toHaveBeenCalledWith("cc-late");
    await handleCallEvent(event("call.answered", { callControlId: "cc-late", clientState: failed.id }));
    expect(mockProvider.startAssistant).not.toHaveBeenCalled();
    expect(mockProvider.hangup).toHaveBeenCalledTimes(2);
    await handleCallEvent(event("call.hangup", { callControlId: "cc-late", clientState: failed.id, hangupCause: "originator_cancel" }));
    // Its ids are kept, so a recording made before the hangup is deleted with the call.
    expect(await callByCcid("cc-late")).toMatchObject({
      id: failed.id,
      status: "failed",
      providerCallSessionId: "sess-late",
      billedCents: 0,
      outcomeMsg: { key: "stored.outcomeNotPlaced" },
    });
  });

  it("keeps a call that a webhook showed was placed when only the dial response was lost", async () => {
    const { user, agent } = await makeLine(1000);
    vi.spyOn(mockProvider, "dial").mockImplementationOnce(async ({ clientState }) => {
      await handleCallEvent(event("call.initiated", { callControlId: "cc-lost", callSessionId: "sess-lost", direction: "outbound", clientState }));
      throw new Error("timeout");
    });
    const call = await startOutboundCall(user, { agentId: agent.id, to: "+14155550100" });
    expect(call).toMatchObject({ status: "initiated", endedAt: null, outcome: null, providerCallControlId: "cc-lost", providerCallSessionId: "sess-lost" });
    await handleCallEvent(event("call.answered", { callControlId: "cc-lost", clientState: call.id }));
    expect(mockProvider.startAssistant).toHaveBeenCalledWith("cc-lost", expect.objectContaining({ assistantId: "assistant-test" }));
    expect(mockProvider.hangup).not.toHaveBeenCalled();
  });

  it("starts the assistant on an answered call whose call control id was never stored", async () => {
    const line = await makeLine(1000);
    const [c] = await db
      .insert(calls)
      .values({ userId: line.user.id, agentId: line.agent.id, phoneNumberId: line.number.id, direction: "outbound", fromNumber: line.number.e164, toNumber: "+14155550100" })
      .returning();
    await handleCallEvent(event("call.answered", { callControlId: "cc-unstored", clientState: c.id }));
    expect(mockProvider.startAssistant).toHaveBeenCalledWith("cc-unstored", expect.objectContaining({ assistantId: "assistant-test" }));
    expect(await callByCcid("cc-unstored")).toMatchObject({ id: c.id, status: "answered" });
  });

  it("keeps the real outcome when the hangup was processed before the dial error", async () => {
    const { user, agent } = await makeLine(1000);
    vi.spyOn(mockProvider, "dial").mockImplementationOnce(async ({ clientState }) => {
      // Telnyx placed the call and it was declined, but the dial response is lost.
      await handleCallEvent(event("call.hangup", { clientState, hangupCause: "call_rejected" }));
      throw new Error("socket hang up");
    });
    const call = await startOutboundCall(user, { agentId: agent.id, to: "+14155550100" });
    expect(call).toMatchObject({ status: "failed", outcomeMsg: { key: "stored.outcomeDeclined" }, hangupCause: "call_rejected" });
  });

  it("hangs up without charging when the assistant can't start on an answered outbound call", async () => {
    const line = await makeLine(1000);
    const c = await outboundRow(line);
    vi.mocked(mockProvider.startAssistant).mockRejectedValueOnce(new Error("telnyx 500"));
    await handleCallEvent(event("call.answered", { callControlId: "cc-out", clientState: c.id }));
    expect(mockProvider.hangup).toHaveBeenCalledWith("cc-out");
    await handleCallEvent(event("call.hangup", { callControlId: "cc-out", clientState: c.id, hangupCause: "normal_clearing", occurredAt: new Date(Date.now() + 90_000) }));
    expect(await callByCcid("cc-out")).toMatchObject({ status: "failed", chargeWaived: true, billedCents: 0 });
    expect(await balance(line.user.id)).toBe(1000);
  });

  it("hangs up without charging when the agent was deleted before the call was answered", async () => {
    const line = await makeLine(1000);
    const c = await outboundRow(line);
    await db.update(agents).set({ providerAssistantId: null, deletedAt: new Date() }).where(eq(agents.id, line.agent.id));
    await handleCallEvent(event("call.answered", { callControlId: "cc-out", clientState: c.id }));
    expect(mockProvider.startAssistant).not.toHaveBeenCalled();
    expect(mockProvider.hangup).toHaveBeenCalledWith("cc-out");
    expect(await callByCcid("cc-out")).toMatchObject({ chargeWaived: true, outcomeMsg: { key: "stored.outcomeAgentUnavailable" } });
  });

  it("keeps a call record whose recording couldn't be deleted, and says so", async () => {
    const line = await makeLine(1000);
    const [c] = await db
      .insert(calls)
      .values({ userId: line.user.id, phoneNumberId: line.number.id, direction: "inbound", fromNumber: "+12025550123", toNumber: line.number.e164, providerCallControlId: "cc-del", status: "completed", endedAt: new Date(), hasRecording: true })
      .returning();
    vi.spyOn(mockProvider, "purgeCallData").mockRejectedValueOnce(new Error("telnyx 500"));
    await expect(deleteCallRecord(line.user.id, c.id)).rejects.toThrow(/delete the recording/);
    expect(await callByCcid("cc-del")).toMatchObject({ deletedAt: null, purgedAt: null, hasRecording: true });
  });
});

describe("out-of-order and lost events", () => {
  const t0 = new Date("2026-10-07T10:00:00Z");
  async function answeredCall() {
    const line = await makeLine(1000);
    await handleCallEvent(inbound(line.number.e164));
    return { ...line, call: await callByCcid("cc-1") };
  }
  const answered = (callId: string) => event("call.answered", { callControlId: "cc-1", clientState: callId, occurredAt: t0 });
  const hangup = (callId: string) =>
    event("call.hangup", { callControlId: "cc-1", clientState: callId, hangupCause: "normal_clearing", occurredAt: new Date(t0.getTime() + 61_000) });
  const balance = async (userId: string) => (await db.select().from(users).where(eq(users.id, userId)))[0].balanceCents;

  it("bills a call whose answer is processed after its hangup, once", async () => {
    const { user, call } = await answeredCall();
    await handleCallEvent(hangup(call.id));
    expect((await callByCcid("cc-1")).status).toBe("failed");

    await handleCallEvent(answered(call.id));
    await handleCallEvent(answered(call.id)); // redelivered with a new event id
    expect(await callByCcid("cc-1")).toMatchObject({ status: "completed", durationSec: 61, billedCents: 30, outcome: null, resultsFetched: false });
    expect(await balance(user.id)).toBe(970);
  });

  it("leaves an outbound call free when its answer is processed after its hangup (its assistant never started)", async () => {
    const { user, agent, number } = await makeLine(1000);
    const ccid = "cc-out";
    const [call] = await db
      .insert(calls)
      .values({ userId: user.id, agentId: agent.id, phoneNumberId: number.id, direction: "outbound", fromNumber: number.e164, toNumber: "+12025550199", providerCallControlId: ccid })
      .returning();
    await handleCallEvent(event("call.hangup", { callControlId: ccid, clientState: call.id, hangupCause: "normal_clearing", occurredAt: new Date(t0.getTime() + 61_000) }));
    await handleCallEvent(event("call.answered", { callControlId: ccid, clientState: call.id, occurredAt: t0 }));
    const [row] = await db.select().from(calls).where(eq(calls.id, call.id));
    expect(row).toMatchObject({ status: "failed", billedCents: 0 });
    expect(mockProvider.startAssistant).not.toHaveBeenCalled();
    expect(await balance(user.id)).toBe(1000);
  });

  it("settles an answer and a hangup processed at the same moment", async () => {
    const { user, number, call } = await answeredCall();
    await Promise.all([handleCallEvent(answered(call.id)), handleCallEvent(hangup(call.id))]);
    expect(await callByCcid("cc-1")).toMatchObject({ status: "completed", billedCents: 30, endedAt: expect.any(Date) });
    expect(await balance(user.id)).toBe(970);
    // The next caller isn't turned away as busy.
    await handleCallEvent(inbound(number.e164, "cc-2"));
    expect((await callByCcid("cc-2")).status).toBe("initiated");
  });

  it("deletes a recording saved after the call record was deleted", async () => {
    const { user, call } = await answeredCall();
    await handleCallEvent(answered(call.id));
    await handleCallEvent(hangup(call.id));
    const purge = vi.spyOn(mockProvider, "purgeCallData");
    await deleteCallRecord(user.id, call.id);
    await handleCallEvent(event("call.recording.saved", { callSessionId: "sess-cc-1" }));
    expect(purge).toHaveBeenCalledTimes(2);
    expect((await callByCcid("cc-1")).hasRecording).toBe(false);
  });

  it("doesn't write results onto a call deleted while they were being fetched", async () => {
    const { user, call } = await answeredCall();
    await handleCallEvent(answered(call.id));
    await handleCallEvent(hangup(call.id));
    vi.mocked(mockProvider.getCallResults).mockImplementation(async () => {
      await deleteCallRecord(user.id, call.id);
      return { transcript: [{ role: "user", text: "secret" }], summary: "secret" };
    });
    await fetchCallResults(await callByCcid("cc-1"));
    expect(await callByCcid("cc-1")).toMatchObject({ transcript: null, summary: null });
  });
});

describe("call results", () => {
  const transcript = [{ role: "user", text: "Hi" }];
  async function endedCall(endedAgoMs: number, ccid = "cc-r") {
    const line = await makeLine(1000);
    const endedAt = new Date(Date.now() - endedAgoMs);
    const [c] = await db
      .insert(calls)
      .values({ userId: line.user.id, phoneNumberId: line.number.id, direction: "inbound", fromNumber: "+12025550123", toNumber: line.number.e164, providerCallControlId: ccid, status: "completed", answeredAt: new Date(endedAt.getTime() - 60_000), endedAt })
      .returning();
    return c;
  }

  it("keeps the transcript while the summary is still being generated, then adds the summary", async () => {
    const c = await endedCall(60_000);
    vi.mocked(mockProvider.getCallResults).mockResolvedValueOnce({ transcript, summaryPending: true });
    const first = await fetchCallResults(c);
    expect(first).toMatchObject({ transcript, summary: null, resultsFetched: false });
    expect(isAwaitingResults(first)).toBe(true);
    vi.mocked(mockProvider.getCallResults).mockResolvedValueOnce({ transcript, summary: "Said hi." });
    expect(await fetchCallResults(first)).toMatchObject({ transcript, summary: "Said hi.", resultsFetched: true });
  });

  it("keeps waiting for results soon after the call, including after a failed fetch", async () => {
    const c = await endedCall(60_000);
    expect(await fetchCallResults(c)).toMatchObject({ resultsFetched: false });
    vi.mocked(mockProvider.getCallResults).mockRejectedValueOnce(new Error("telnyx 503"));
    expect(await fetchCallResults(c)).toMatchObject({ resultsFetched: false });
    expect(isAwaitingResults(c)).toBe(true);
  });

  it("stops waiting for results that still aren't there long after the call", async () => {
    const none = await endedCall(RESULTS_WAIT_MS + 60_000, "cc-none");
    expect(isAwaitingResults(none)).toBe(false);
    expect(await fetchCallResults(none)).toMatchObject({ resultsFetched: true, transcript: null, summary: null });

    // A summary that never finished: the transcript is kept without it.
    const pending = await endedCall(RESULTS_WAIT_MS + 60_000, "cc-pending");
    vi.mocked(mockProvider.getCallResults).mockResolvedValueOnce({ transcript, summaryPending: true });
    expect(await fetchCallResults(pending)).toMatchObject({ resultsFetched: true, transcript, summary: null });
  });
});

describe("webhook redelivery", () => {
  it("processes a redelivery that arrives while the first attempt is still running, then skips later ones", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withWebhookDedupe("telnyx", "evt-x", "call.hangup", async () => {
      runs++;
      await gate;
    });
    await withWebhookDedupe("telnyx", "evt-x", "call.hangup", async () => {
      runs++;
    });
    release();
    await first;
    await withWebhookDedupe("telnyx", "evt-x", "call.hangup", async () => {
      runs++;
    });
    expect(runs).toBe(2);
  });

  it("retries an event whose processing failed", async () => {
    await expect(withWebhookDedupe("stripe", "evt-y", "checkout.session.completed", async () => {
      throw new Error("db down");
    })).rejects.toThrow("db down");
    let ran = false;
    await withWebhookDedupe("stripe", "evt-y", "checkout.session.completed", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe("call page polling", () => {
  it("waits for results only for a while after hangup, and only for completed calls", () => {
    const now = Date.now();
    const ended = (minutesAgo: number) => ({ status: "completed" as const, resultsFetched: false, endedAt: new Date(now - minutesAgo * 60_000) });
    expect(isAwaitingResults(ended(1), now)).toBe(true);
    expect(isAwaitingResults(ended(RESULTS_WAIT_MS / 60_000 + 1), now)).toBe(false);
    expect(isAwaitingResults({ ...ended(1), resultsFetched: true }, now)).toBe(false);
    expect(isAwaitingResults({ ...ended(1), status: "failed" }, now)).toBe(false);
  });
});
