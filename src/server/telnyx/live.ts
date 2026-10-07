import { createPublicKey, verify } from "node:crypto";
import { config } from "@/lib/config";
import { encodeClientState, parseTelnyxEnvelope } from "./events";
import { STOCK_VOICES } from "./stock-voices";
import type { AssistantSpec, CallRef, ClonedVoiceResult, NumberOrderResult, OrderStatus, VoiceProvider } from "./types";

/**
 * Telnyx v2 REST adapter. Field names follow docs/telnyx-api-notes.md; items
 * marked UNCONFIRMED there must be verified against a live account.
 */

const BASE = "https://api.telnyx.com/v2";
const SIGNATURE_TOLERANCE_SEC = 300;
// DER prefix that wraps a raw 32-byte Ed25519 key as SPKI.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type TelnyxConfig = typeof config.telnyx;

export class TelnyxApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    path: string,
  ) {
    super(`Telnyx ${status} on ${path}: ${body.slice(0, 500)}`);
  }
}

export function createTelnyxProvider(cfg: TelnyxConfig): VoiceProvider {
  if (!cfg.apiKey) throw new Error("TELNYX_API_KEY is required in live mode");
  if (!cfg.connectionId) throw new Error("TELNYX_CONNECTION_ID is required in live mode");
  if (!cfg.publicKey) throw new Error("TELNYX_PUBLIC_KEY is required in live mode");

  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(cfg.publicKey, "base64")]),
    format: "der",
    type: "spki",
  });

  async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const isForm = body instanceof FormData;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: "application/json",
        ...(body && !isForm ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new TelnyxApiError(res.status, text, path);
    return (text ? JSON.parse(text) : {}) as T;
  }

  const action = (ccid: string, cmd: string, body: Record<string, unknown> = {}) =>
    api("POST", `/calls/${encodeURIComponent(ccid)}/actions/${cmd}`, body);

  const recordOpts = { record: "record-from-answer", record_format: "mp3", record_channels: "dual" };

  function assistantBody(spec: AssistantSpec) {
    return {
      name: spec.name,
      instructions: spec.instructions,
      greeting: spec.greeting,
      ...(cfg.llmModel ? { model: cfg.llmModel } : {}),
      voice_settings: { voice: spec.voiceRef },
      transcription: {
        model: cfg.sttModel,
        // "auto" tolerates EN/ZH mixing; fall back to the agent's primary language otherwise.
        language: cfg.sttLanguage === "primary" ? spec.language : cfg.sttLanguage,
      },
      enabled_features: ["telephony"],
      privacy_settings: { data_retention: true },
      ...(cfg.insightGroupId ? { insight_settings: { insight_group_id: cfg.insightGroupId } } : {}),
    };
  }

  type Order = { id: string; status: string; phone_numbers?: { phone_number: string; status: string }[] };

  async function toOrderResult(order: Order): Promise<NumberOrderResult> {
    const status: OrderStatus =
      order.status === "success" ? "success" : order.status === "pending" ? "pending" : "failure";
    let numberId: string | undefined;
    const e164 = order.phone_numbers?.[0]?.phone_number;
    if (status === "success" && e164) {
      // The order item id is not the phone-number resource id; look that up.
      const list = await api<{ data: { id: string }[] }>(
        "GET",
        `/phone_numbers?filter[phone_number]=${encodeURIComponent(e164)}`,
      );
      numberId = list.data[0]?.id;
    }
    return {
      orderId: order.id,
      status,
      numberId,
      failureReason: status === "failure" ? `Order ${order.status}` : undefined,
    };
  }

  function toClone(d: { id: string; status: string; provider_voice_id?: string; model_id?: string }): ClonedVoiceResult {
    const model = d.model_id ?? cfg.cloneModel;
    return {
      voiceId: d.id,
      ref: `Telnyx.${model}.${d.provider_voice_id ?? d.id}`,
      status: d.status === "active" ? "ready" : d.status === "pending" ? "processing" : "failed",
      failureReason: d.status === "expired" ? "Voice expired at the provider." : d.status === "failed" ? "Cloning failed." : undefined,
    };
  }

  async function findConversationId(ref: CallRef): Promise<string | null> {
    if (ref.conversationId) return ref.conversationId;
    const res = await api<{ data: { id: string }[] }>(
      "GET",
      `/ai/conversations?metadata->call_control_id=eq.${encodeURIComponent(ref.callControlId)}&limit=1`,
    );
    return res.data[0]?.id ?? null;
  }

  async function listRecordings(ref: CallRef) {
    const res = await api<{ data: { id: string; download_urls?: { mp3?: string; wav?: string } }[] }>(
      "GET",
      `/recordings?filter[call_control_id]=${encodeURIComponent(ref.callControlId)}`,
    );
    return res.data;
  }

  return {
    name: "telnyx",

    async searchNumbers({ areaCode, limit = 10 }) {
      const q = new URLSearchParams({
        "filter[country_code]": "US",
        "filter[phone_number_type]": "local",
        "filter[features][]": "voice",
        "filter[limit]": String(limit),
      });
      if (areaCode) q.set("filter[national_destination_code]", areaCode);
      const res = await api<{
        data: { phone_number: string; best_effort?: boolean; region_information?: { region_type: string; region_name: string }[] }[];
      }>("GET", `/available_phone_numbers?${q}`);
      return res.data
        .filter((n) => !n.best_effort)
        .map((n) => ({
          e164: n.phone_number,
          locality: n.region_information?.find((r) => r.region_type === "rate_center")?.region_name,
          region: n.region_information?.find((r) => r.region_type === "state")?.region_name,
        }));
    },

    async orderNumber(e164) {
      const res = await api<{ data: Order }>("POST", "/number_orders", {
        phone_numbers: [{ phone_number: e164 }],
        connection_id: cfg.connectionId,
      });
      return toOrderResult(res.data);
    },

    async getNumberOrder(orderId) {
      const res = await api<{ data: Order }>("GET", `/number_orders/${encodeURIComponent(orderId)}`);
      return toOrderResult(res.data);
    },

    async releaseNumber(numberId) {
      await api("DELETE", `/phone_numbers/${encodeURIComponent(numberId)}`);
    },

    async listStockVoices() {
      return STOCK_VOICES;
    },

    maxCloneSampleBytes: 5 * 1024 * 1024,

    async cloneVoice({ name, language, gender, audio }) {
      const form = new FormData();
      form.set("audio_file", audio, audio instanceof File ? audio.name : "sample.wav");
      form.set("name", name);
      form.set("language", language);
      form.set("gender", gender);
      form.set("provider", "telnyx");
      form.set("model_id", cfg.cloneModel);
      const res = await api<{ data: Parameters<typeof toClone>[0] }>("POST", "/voice_clones/from_upload", form);
      return toClone(res.data);
    },

    async getClonedVoice(voiceId) {
      // UNCONFIRMED: docs mention GET /voice_clones/{id}; the OpenAPI spec doesn't define it.
      const res = await api<{ data: Parameters<typeof toClone>[0] }>("GET", `/voice_clones/${encodeURIComponent(voiceId)}`);
      return toClone(res.data);
    },

    async deleteClonedVoice(voiceId) {
      await api("DELETE", `/voice_clones/${encodeURIComponent(voiceId)}`);
    },

    async createAssistant(spec) {
      // Assistant endpoints return the object unwrapped (no `data`).
      const res = await api<{ id: string }>("POST", "/ai/assistants", assistantBody(spec));
      return { assistantId: res.id };
    },

    async updateAssistant(assistantId, spec) {
      await api("POST", `/ai/assistants/${encodeURIComponent(assistantId)}`, assistantBody(spec));
    },

    async deleteAssistant(assistantId) {
      await api("DELETE", `/ai/assistants/${encodeURIComponent(assistantId)}?hard_delete=true`);
    },

    async dial({ from, to, clientState }) {
      const res = await api<{ data: { call_control_id: string; call_session_id?: string } }>("POST", "/calls", {
        connection_id: cfg.connectionId,
        from,
        to,
        client_state: encodeClientState(clientState),
        timeout_secs: 30,
        ...recordOpts,
      });
      return { callControlId: res.data.call_control_id, callSessionId: res.data.call_session_id };
    },

    async answer(ccid, clientState, assistant) {
      // The stored assistant already carries voice/greeting; per-call overrides would
      // replace (not merge) voice_settings, so only the id is sent.
      await action(ccid, "answer", {
        client_state: encodeClientState(clientState),
        command_id: `${clientState}:answer`,
        assistant: { id: assistant.assistantId },
        ...recordOpts,
      });
    },

    async reject(ccid, cause) {
      await action(ccid, "reject", { cause });
    },

    async hangup(ccid) {
      await action(ccid, "hangup");
    },

    async startAssistant(ccid, assistant) {
      const res = await api<{ data: { conversation_id?: string } }>(
        "POST",
        `/calls/${encodeURIComponent(ccid)}/actions/ai_assistant_start`,
        { assistant: { id: assistant.assistantId }, command_id: `${ccid}:assistant` },
      );
      return { conversationId: res.data?.conversation_id };
    },

    async getCallResults(ref) {
      const conversationId = await findConversationId(ref);
      if (!conversationId) return null;
      const msgs = await api<{ data: { role: string; text?: string; sent_at?: string; created_at?: string }[] }>(
        "GET",
        `/ai/conversations/${encodeURIComponent(conversationId)}/messages?page[size]=250`,
      );
      const transcript = msgs.data
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.text)
        .sort((a, b) => (a.sent_at ?? a.created_at ?? "").localeCompare(b.sent_at ?? b.created_at ?? ""))
        .map((m) => ({ role: m.role, text: m.text! }));

      let summary: string | undefined;
      if (cfg.insightGroupId) {
        const ins = await api<{ data: { status: string; conversation_insights?: { result: string }[] }[] }>(
          "GET",
          `/ai/conversations/${encodeURIComponent(conversationId)}/conversations-insights`,
        );
        const done = ins.data.find((i) => i.status === "completed");
        if (!done && ins.data.some((i) => i.status === "pending" || i.status === "in_progress")) return null; // retry later
        summary = done?.conversation_insights?.[0]?.result;
      }
      return { transcript, summary };
    },

    async getRecordingUrl(ref) {
      const recs = await listRecordings(ref);
      return recs[0]?.download_urls?.mp3 ?? recs[0]?.download_urls?.wav ?? null;
    },

    async deleteRecordings(ref) {
      for (const r of await listRecordings(ref)) await api("DELETE", `/recordings/${encodeURIComponent(r.id)}`);
    },

    async parseWebhook(rawBody, headers) {
      const signature = headers.get("telnyx-signature-ed25519");
      const timestamp = headers.get("telnyx-timestamp");
      if (!signature || !timestamp) throw new Error("Missing Telnyx signature headers");
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SEC) throw new Error("Stale Telnyx webhook");
      const ok = verify(null, Buffer.from(`${timestamp}|${rawBody}`), publicKey, Buffer.from(signature, "base64"));
      if (!ok) throw new Error("Invalid Telnyx signature");
      return parseTelnyxEnvelope(JSON.parse(rawBody));
    },
  };
}
