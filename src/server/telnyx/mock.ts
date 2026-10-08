import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { encodeClientState, parseTelnyxEnvelope } from "./events";
import { MOCK_MODELS, toOfferedModels } from "./models";
import { MOCK_CATALOG, toStockVoices } from "./stock-voices";
import type { CallResults, ClonedVoiceResult, VoiceProvider } from "./types";

/**
 * In-memory stand-in for Telnyx so the whole product loop runs locally
 * without credentials. Call progress is simulated by emitting webhook-shaped
 * events into the same handler the real webhook route uses.
 */

type SimCall = { from: string; to: string; direction: "inbound" | "outbound"; clientState?: string; sessionId: string; answeredAt?: Date };

const g = globalThis as unknown as {
  __mockTelnyx?: { calls: Map<string, SimCall>; clones: Map<string, { createdAt: number }> };
};
const state = (g.__mockTelnyx ??= { calls: new Map(), clones: new Map() });

/** Seconds a simulated answered call lasts. */
export const MOCK_CALL_SECONDS = 75;


async function emit(type: string, callControlId: string, extra: Record<string, unknown> = {}, delayMs = 0) {
  const call = state.calls.get(callControlId);
  if (!call) return;
  setTimeout(async () => {
    const { handleCallEvent } = await import("@/server/calls/events");
    const event = parseTelnyxEnvelope({
      data: {
        id: randomUUID(),
        event_type: type,
        occurred_at: new Date().toISOString(),
        payload: {
          call_control_id: callControlId,
          call_session_id: call.sessionId,
          direction: call.direction === "inbound" ? "incoming" : "outgoing",
          from: call.from,
          to: call.to,
          client_state: call.clientState ? encodeClientState(call.clientState) : undefined,
          ...extra,
        },
      },
    });
    try {
      await handleCallEvent(event);
    } catch (err) {
      console.error("[mock-telnyx] event handler failed", err);
    }
  }, delayMs);
}

function scheduleEnd(callControlId: string, afterMs: number) {
  setTimeout(() => {
    const call = state.calls.get(callControlId);
    if (!call?.answeredAt) return;
    void emit("call.hangup", callControlId, { hangup_cause: "normal_clearing", start_time: call.answeredAt.toISOString() });
    void emit("call.recording.saved", callControlId, { call_control_id: undefined, client_state: undefined }, 200);
    void emit("call.cost", callControlId, { total_cost: "0.0070", billed_duration_secs: 60 }, 400);
  }, afterMs);
}

/** Simulated answered calls are compressed: 1 real second = 15 call seconds. */
const TIME_SCALE = 15;

export const mockProvider: VoiceProvider = {
  name: "mock",

  async searchNumbers({ areaCode, limit = 10 }) {
    const area = areaCode && /^\d{3}$/.test(areaCode) ? areaCode : "415";
    return Array.from({ length: limit }, (_, i) => ({
      e164: `+1${area}555${String(1000 + ((i * 137) % 9000)).padStart(4, "0")}`,
      locality: "Mock City",
      region: "CA",
      nearby: false,
    }));
  },

  async orderNumber(e164) {
    return { orderId: `ord_${randomUUID()}`, status: "pending", numberId: `num_${e164.slice(1)}` };
  },

  async getNumberOrder(orderId) {
    return { orderId, status: "success" };
  },

  async releaseNumber() {},

  async listStockVoices() {
    return toStockVoices(MOCK_CATALOG);
  },

  async synthesizePreview() {
    return mockAudio();
  },

  async getCloneSample() {
    return mockAudio();
  },

  async listModels() {
    return toOfferedModels(MOCK_MODELS);
  },

  maxCloneSampleBytes: 5 * 1024 * 1024,

  async cloneVoice({ audio }) {
    if (audio.size < 1000) {
      return { voiceId: "", ref: "", status: "failed", failureReason: "Audio sample too short" };
    }
    const voiceId = `clone_${randomUUID()}`;
    state.clones.set(voiceId, { createdAt: Date.now() });
    return { voiceId, ref: `Telnyx.Clone.${voiceId}`, status: "processing" };
  },

  async getClonedVoice(voiceId): Promise<ClonedVoiceResult> {
    const c = state.clones.get(voiceId);
    if (!c) return { voiceId, ref: "", status: "failed", failureReason: "Voice not found" };
    const ready = Date.now() - c.createdAt > 3000;
    return { voiceId, ref: `Telnyx.Clone.${voiceId}`, status: ready ? "ready" : "processing" };
  },

  async deleteClonedVoice(voiceId) {
    state.clones.delete(voiceId);
  },

  async createAssistant() {
    return { assistantId: `assistant-${randomUUID()}` };
  },
  async updateAssistant() {},
  async deleteAssistant() {},

  async dial({ from, to, clientState }) {
    const id = `v3:mock-${randomUUID()}`;
    state.calls.set(id, { from, to, direction: "outbound", clientState, sessionId: randomUUID() });
    void emit("call.initiated", id, {}, 100);
    if (to.endsWith("0000")) {
      // Test convention: numbers ending in 0000 never answer.
      void emit("call.hangup", id, { hangup_cause: "timeout" }, 3000);
    } else {
      setTimeout(() => {
        const c = state.calls.get(id);
        if (c) c.answeredAt = new Date();
        void emit("call.answered", id);
        scheduleEnd(id, (MOCK_CALL_SECONDS * 1000) / TIME_SCALE);
      }, 1500);
    }
    return { callControlId: id, callSessionId: state.calls.get(id)!.sessionId };
  },

  async answer(callControlId, clientState) {
    // Real Telnyx starts the assistant as part of answer.
    const c = state.calls.get(callControlId);
    if (!c) return;
    c.clientState = clientState;
    c.answeredAt = new Date();
    void emit("call.answered", callControlId, {}, 300);
    scheduleEnd(callControlId, (MOCK_CALL_SECONDS * 1000) / TIME_SCALE);
  },

  async reject(callControlId) {
    void emit("call.hangup", callControlId, { hangup_cause: "call_rejected" }, 100);
  },

  async hangup(callControlId) {
    const c = state.calls.get(callControlId);
    if (!c) return;
    void emit("call.hangup", callControlId, { hangup_cause: "normal_clearing", start_time: c.answeredAt?.toISOString() });
    c.answeredAt = undefined; // prevent scheduled end from firing twice
  },

  async startAssistant() {
    return { conversationId: `conv-${randomUUID()}` };
  },

  async getCallResults(): Promise<CallResults> {
    return {
      transcript: [
        { role: "assistant", text: "Hi! This call may be recorded. How can I help you today?" },
        { role: "user", text: "Just testing the mock line." },
        { role: "assistant", text: "Everything is working. Anything else?" },
        { role: "user", text: "No, thanks. Bye!" },
      ],
      summary: "Caller tested the line; no follow-up needed.",
    };
  },

  async getRecordingUrl() {
    return "/mock-recording.wav";
  },

  async purgeCallData() {},

  async parseWebhook() {
    // Mock events are delivered in-process; anything arriving over HTTP is unsigned and untrusted.
    throw new Error("Mock provider does not accept HTTP webhooks");
  },
};

async function mockAudio() {
  const buf = await readFile(path.join(process.cwd(), "public/mock-recording.wav"));
  return { audio: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, contentType: "audio/wav" };
}

/** Dev helper: simulate an inbound PSTN call to one of our numbers. */
export function simulateInboundCall(from: string, to: string): string {
  const id = `v3:mock-${randomUUID()}`;
  state.calls.set(id, { from, to, direction: "inbound", sessionId: randomUUID() });
  void emit("call.initiated", id);
  return id;
}
