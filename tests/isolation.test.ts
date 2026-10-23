import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { agents, calls, voices } from "@/db/schema";
import { deleteAgent, getUserAgent, listUserAgents, updateAgent } from "@/server/agents";
import { deleteCallRecord, getRecordingUrl, getUserCall, hangupCall, listUserCalls, startOutboundCall } from "@/server/calls";
import { assignAgentToNumber, listUserNumbers, releaseNumber } from "@/server/numbers";
import { mockProvider } from "@/server/telnyx/mock";
import { deleteVoice, listUserVoices, voicePreview } from "@/server/voices";
import { makeLine, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

/** SPEC §13.8: each user's resources and records are isolated. */
describe("per-user isolation", () => {
  async function twoUsers() {
    const a = await makeLine(1000);
    const b = await makeLine(1000);
    const [call] = await db
      .insert(calls)
      .values({ userId: a.user.id, agentId: a.agent.id, phoneNumberId: a.number.id, direction: "inbound", fromNumber: "+12025550123", toNumber: a.number.e164, providerCallControlId: "cc-a", status: "completed", endedAt: new Date(), hasRecording: true })
      .returning();
    const [voice] = await db
      .insert(voices)
      .values({ userId: a.user.id, name: "A's voice", language: "en", consentAt: new Date(), status: "ready" })
      .returning();
    return { a, b, call, voice };
  }

  it("lists only the caller's own resources", async () => {
    const { a, b } = await twoUsers();
    expect((await listUserAgents(b.user.id)).map((x) => x.id)).toEqual([b.agent.id]);
    expect((await listUserNumbers(b.user.id)).map((x) => x.id)).toEqual([b.number.id]);
    expect(await listUserCalls(b.user.id)).toHaveLength(0);
    expect(await listUserVoices(b.user.id)).toHaveLength(0);
    expect(await listUserCalls(a.user.id)).toHaveLength(1);
  });

  it("can't read another user's agent, call or recording", async () => {
    const { a, b, call } = await twoUsers();
    expect(await getUserAgent(b.user.id, a.agent.id)).toBeNull();
    expect(await getUserCall(b.user.id, call.id)).toBeNull();
    expect(await getRecordingUrl(b.user.id, call.id)).toBeNull();
  });

  it("can't modify or delete another user's resources", async () => {
    const { a, b, call, voice } = await twoUsers();
    const input = { name: "x", instructions: "x", greeting: "x", language: "en", voice: "stock:Telnyx.KokoroTTS.af_heart" };
    await expect(updateAgent(b.user.id, a.agent.id, input)).rejects.toThrow(/not found/);
    await expect(deleteAgent(b.user.id, a.agent.id)).rejects.toThrow(/not found/);
    await expect(releaseNumber(b.user.id, a.number.id)).rejects.toThrow(/not found/);
    await expect(assignAgentToNumber(b.user.id, a.number.id, b.agent.id)).rejects.toThrow(/not found/);
    await expect(assignAgentToNumber(a.user.id, a.number.id, b.agent.id)).rejects.toThrow(/Agent not found/);
    await expect(deleteVoice(b.user.id, voice.id)).rejects.toThrow(/not found/);
    await expect(deleteCallRecord(b.user.id, call.id)).rejects.toThrow(/not found/);
  });

  it("can't hang up another user's live call", async () => {
    const { a, b } = await twoUsers();
    const [live] = await db
      .insert(calls)
      .values({ userId: a.user.id, agentId: a.agent.id, phoneNumberId: a.number.id, direction: "inbound", fromNumber: "+12025550123", toNumber: a.number.e164, providerCallControlId: "cc-live", status: "answered", answeredAt: new Date() })
      .returning();
    const hangup = vi.spyOn(mockProvider, "hangup").mockResolvedValue();
    await hangupCall(b.user.id, live.id);
    expect(hangup).not.toHaveBeenCalled();
    await hangupCall(a.user.id, live.id); // the owner can
    expect(hangup).toHaveBeenCalledWith("cc-live");
  });

  it("can't place calls with another user's agent", async () => {
    const { a, b } = await twoUsers();
    await expect(startOutboundCall(b.user, { agentId: a.agent.id, to: "4155550100" })).rejects.toThrow(/Agent not found/);
  });

  it("can't use another user's clone as an agent voice", async () => {
    const { b, voice } = await twoUsers();
    const input = { name: "x", instructions: "x", greeting: "x", language: "en", voice: `clone:${voice.id}` };
    await expect(updateAgent(b.user.id, b.agent.id, input)).rejects.toThrow(/Unknown voice/);
  });
});

describe("malformed ids", () => {
  it("treats an id that isn't a UUID as not found instead of failing", async () => {
    const { user, agent } = await makeLine(1000);
    const bad = "not-a-uuid";
    expect(await getUserCall(user.id, bad)).toBeNull();
    expect(await getRecordingUrl(user.id, bad)).toBeNull();
    await expect(deleteCallRecord(user.id, bad)).rejects.toThrow(/not found/);
    await expect(hangupCall(user.id, bad)).resolves.toBeUndefined();
    expect(await getUserAgent(user.id, bad)).toBeNull();
    await expect(startOutboundCall(user, { agentId: bad, to: "4155550100" })).rejects.toThrow(/Agent not found/);
    const input = { name: "x", instructions: "x", greeting: "x", language: "en", voice: `clone:${bad}` };
    await expect(updateAgent(user.id, agent.id, input)).rejects.toThrow(/Unknown voice/);
    expect(await voicePreview(user.id, `clone:${bad}`)).toBeNull();
  });
});

describe("outbound call goal", () => {
  it("stores the goal for the call and rejects overly long goals", async () => {
    const { user, agent } = await makeLine(1000);
    vi.spyOn(mockProvider, "dial").mockResolvedValue({ callControlId: "cc-goal" });
    const call = await startOutboundCall(user, { agentId: agent.id, to: "4155550100", goal: "  Reschedule my haircut  " });
    expect(call.goal).toBe("Reschedule my haircut");
    await db.update(calls).set({ status: "completed" }).where(eq(calls.id, call.id));
    await expect(startOutboundCall(user, { agentId: agent.id, to: "4155550101", goal: "x".repeat(1001) })).rejects.toThrow(/under 1000/);
  });
});

describe("outbound call variables", () => {
  it("keeps only values for the agent's ask-on-each-call variables, and skips blank ones", async () => {
    const { user, agent } = await makeLine(1000);
    await db
      .update(agents)
      .set({
        variables: [
          { key: "owner_name", value: "Alex", askPerCall: false },
          { key: "callback_number", value: "", askPerCall: true },
          { key: "party_size", value: "2", askPerCall: true },
        ],
      })
      .where(eq(agents.id, agent.id));
    vi.spyOn(mockProvider, "dial").mockResolvedValue({ callControlId: "cc-vars" });
    const call = await startOutboundCall(user, {
      agentId: agent.id,
      to: "4155550100",
      variables: { owner_name: "Mallory", callback_number: " +12025550111 ", party_size: "  ", unknown: "x" },
    });
    expect(call.variables).toEqual({ callback_number: "+12025550111" });
  });
});

describe("outbound admission", () => {
  it("starts only one of two simultaneous outbound calls", async () => {
    const { user, agent } = await makeLine(1000);
    vi.spyOn(mockProvider, "dial").mockImplementation(async () => ({ callControlId: `cc-${Math.random()}` }));
    const results = await Promise.allSettled([
      startOutboundCall(user, { agentId: agent.id, to: "4155550100" }),
      startOutboundCall(user, { agentId: agent.id, to: "4155550101" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(mockProvider.dial).toHaveBeenCalledTimes(1);
  });
});

