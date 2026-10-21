import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stored } from "@/lib/stored-text";
import { encodeClientState, parseCallEnvelope, parseTelnyxEnvelope } from "./events";
import { MOCK_MODELS, toOfferedModels } from "./models";
import { MOCK_CATALOG, toStockVoices } from "./stock-voices";
import type { AssistantSpec, CallResults, ClonedVoiceResult, EmbeddingStatus, VoiceProvider } from "./types";

/**
 * In-memory stand-in for Telnyx so the whole product loop runs locally
 * without credentials. Call progress is simulated by emitting webhook-shaped
 * events into the same handler the real webhook route uses.
 */

type SimCall = { from: string; to: string; direction: "inbound" | "outbound"; clientState?: string; sessionId: string; answeredAt?: Date };
type SimObject = { sizeBytes: number; at: number; unreadable: boolean };
type SimBucket = { embedded: boolean; objects: Map<string, SimObject> };

const g = globalThis as unknown as {
  __mockTelnyx?: {
    calls: Map<string, SimCall>;
    clones: Map<string, { createdAt: number }>;
    buckets: Map<string, SimBucket>;
  };
};
const state = (g.__mockTelnyx ??= { calls: new Map(), clones: new Map(), buckets: new Map() });
state.buckets ??= new Map();

/**
 * Knowledge-base simulation knobs. In dev, failure paths are triggered by content instead:
 * text containing "mock:unreadable" fails to embed; crawled URLs containing "too-large" or "empty"
 * bring in more text than a website source may have, or none.
 */
export const mockKnowledge = {
  /** How long embedding takes. */
  delayMs: 2000,
  bucketLimitReached: false,
  failDeletes: false,
  rejectRetrieval: false,
};

function bucketOf(name: string): SimBucket {
  const b = state.buckets.get(name);
  if (!b) throw new Error(`[mock-telnyx] no bucket ${name}`);
  return b;
}

function checkRetrieval(spec: AssistantSpec) {
  if (spec.knowledgeBucket && mockKnowledge.rejectRetrieval) throw new Error("[mock-telnyx] retrieval tool rejected");
}

/** Seconds a simulated answered call lasts. */
export const MOCK_CALL_SECONDS = 75;


async function emit(type: string, callControlId: string, extra: Record<string, unknown> = {}, delayMs = 0) {
  const call = state.calls.get(callControlId);
  if (!call) return;
  setTimeout(async () => {
    const { handleCallEvent } = await import("@/server/calls/events");
    const event = parseCallEnvelope({
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

  async enableInboundMessaging() {},

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
      return { voiceId: "", ref: "", status: "failed", failureReason: stored("voiceSampleTooShort") };
    }
    const voiceId = `clone_${randomUUID()}`;
    state.clones.set(voiceId, { createdAt: Date.now() });
    return { voiceId, ref: `Telnyx.Clone.${voiceId}`, status: "processing" };
  },

  async getClonedVoice(voiceId): Promise<ClonedVoiceResult> {
    const c = state.clones.get(voiceId);
    if (!c) return { voiceId, ref: "", status: "failed", failureReason: stored("voiceUnavailable") };
    const ready = Date.now() - c.createdAt > 3000;
    return { voiceId, ref: `Telnyx.Clone.${voiceId}`, status: ready ? "ready" : "processing" };
  },

  async deleteClonedVoice(voiceId) {
    state.clones.delete(voiceId);
  },

  async createIntegrationSecret() {
    return { id: `secret-${randomUUID()}` };
  },
  async deleteIntegrationSecret() {},

  async createAssistant(spec) {
    checkRetrieval(spec);
    return { assistantId: `assistant-${randomUUID()}` };
  },
  async updateAssistant(_id, spec) {
    checkRetrieval(spec);
  },
  async deleteAssistant() {},

  async createBucket(bucket) {
    if (state.buckets.has(bucket)) return;
    if (mockKnowledge.bucketLimitReached) throw new Error("[mock-telnyx] TooManyBuckets");
    state.buckets.set(bucket, { embedded: false, objects: new Map() });
  },

  async enableEmbedding(bucket) {
    bucketOf(bucket).embedded = true;
  },

  async putObject(bucket, key, body) {
    const text = body.type.startsWith("text/") ? await body.text() : "";
    bucketOf(bucket).objects.set(key, { sizeBytes: body.size, at: Date.now(), unreadable: text.includes("mock:unreadable") });
  },

  async listObjects(bucket) {
    const b = state.buckets.get(bucket);
    return b ? [...b.objects].map(([key, o]) => ({ key, sizeBytes: o.sizeBytes, modifiedAt: new Date(o.at) })) : [];
  },

  async deleteObject(bucket, key) {
    if (mockKnowledge.failDeletes) throw new Error("[mock-telnyx] delete failed");
    state.buckets.get(bucket)?.objects.delete(key);
  },

  async embeddingStatuses(bucket) {
    const b = state.buckets.get(bucket);
    const out = new Map<string, EmbeddingStatus>();
    if (!b?.embedded) return out;
    for (const [key, o] of b.objects) {
      out.set(key, Date.now() - o.at < mockKnowledge.delayMs ? "processing" : o.unreadable ? "failed" : "ready");
    }
    return out;
  },

  async crawlUrl(bucket, url) {
    const b = bucketOf(bucket);
    const tooLarge = url.includes("too-large");
    const chunks = tooLarge ? 3 : url.includes("empty") ? 0 : 3;
    // Like the real crawler: pages concatenated into plain-text chunks named by crawl depth, up to ~2 MB each.
    for (let i = 0; i < chunks; i++) {
      b.objects.set(`depth-2-${i}.txt`, { sizeBytes: tooLarge ? 2 * 1024 * 1024 : 2000, at: Date.now(), unreadable: false });
    }
    return { taskId: `task-${randomUUID()}` };
  },

  async deleteBucket(bucket) {
    if (mockKnowledge.failDeletes) throw new Error("[mock-telnyx] delete failed");
    const b = state.buckets.get(bucket);
    if (b?.objects.size) throw new Error("[mock-telnyx] BucketNotEmpty");
    state.buckets.delete(bucket);
  },

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

/** Dev helper: simulate a text arriving at one of our numbers, through the real webhook handler. */
export async function simulateInboundMessage(from: string, to: string, text: string): Promise<void> {
  const { handleInboundMessage } = await import("@/server/messages");
  const event = parseTelnyxEnvelope({
    data: {
      id: randomUUID(),
      event_type: "message.received",
      occurred_at: new Date().toISOString(),
      payload: {
        id: randomUUID(),
        direction: "inbound",
        type: "SMS",
        from: { phone_number: from },
        to: [{ phone_number: to, status: "webhook_delivered" }],
        text,
        media: [],
        // GSM-7 fits 160 chars in one segment, 153 per segment once split.
        parts: text.length <= 160 ? 1 : Math.ceil(text.length / 153),
        cost: { amount: "0.0040", currency: "USD" },
      },
    },
  });
  if (event.type !== "message.received") throw new Error("Simulated text did not parse as message.received");
  await handleInboundMessage(event);
}
