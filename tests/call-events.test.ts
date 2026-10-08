import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { calls, ledgerEntries, users } from "@/db/schema";
import { handleCallEvent } from "@/server/calls/events";
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
      voiceRef: "Telnyx.KokoroTTS.af_heart",
      variables: { call_direction: "inbound", call_goal: "" },
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
    expect(await callByCcid("cc-out")).toMatchObject({ status: "failed", outcome: "No answer.", billedCents: 0 });
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
      voiceRef: "Telnyx.KokoroTTS.af_heart",
      variables: { call_direction: "outbound", call_goal: "Move my Thursday appointment" },
      greetingOverride: "Hi, this is an AI assistant calling. This call may be recorded.",
    });
    expect(await callByCcid("cc-out")).toMatchObject({ status: "answered", providerConversationId: "conv-1" });
  });
});
