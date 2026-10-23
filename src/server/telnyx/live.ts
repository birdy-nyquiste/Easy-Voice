import { createPublicKey, verify } from "node:crypto";
import { RESPONSE_TIMING } from "@/lib/agent-settings";
import { config } from "@/lib/config";
import { stored } from "@/lib/stored-text";
import { encodeClientState, parseTelnyxEnvelope } from "./events";
import { toOfferedModels, type CatalogModel } from "./models";
import { isElevenLabsVoice, toStockVoices, type CatalogVoice } from "./stock-voices";
import { createStorageClient } from "./storage";
import {
  FeatureNotPermittedError,
  ProviderHttpError,
  type AssistantSpec,
  type CallRef,
  type EmbeddingStatus,
  type ClonedVoiceResult,
  type LlmModel,
  type NumberOrderResult,
  type OrderStatus,
  type PreviewAudio,
  type StockVoice,
  type VoiceProvider,
} from "./types";

/**
 * Telnyx v2 REST adapter. Field names follow docs/telnyx-api-notes.md; items
 * marked UNCONFIRMED there must be verified against a live account.
 */

const BASE = "https://api.telnyx.com/v2";
const SIGNATURE_TOLERANCE_SEC = 300;
/** Passages the retrieval tool returns per lookup (the portal's default). */
const KNOWLEDGE_RESULTS = 3;
/** Shown to the model as the hangup tool's description: when it may end the call. */
export const HANGUP_TOOL_DESCRIPTION =
  "End the call once the conversation is complete: the caller has said goodbye, or there is nothing left to do and you have said goodbye.";
/** 100 messages per page; a 30-minute call stays well under this. */
const MAX_MESSAGE_PAGES = 10;
// DER prefix that wraps a raw 32-byte Ed25519 key as SPKI.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type TelnyxConfig = typeof config.telnyx;

/** Long enough for uploads and speech; without one, a hung Telnyx request would hold a webhook open for minutes. */
const REQUEST_TIMEOUT_MS = 30_000;

export class TelnyxApiError extends ProviderHttpError {
  constructor(
    status: number,
    public body: string,
    path: string,
  ) {
    super(status, `Telnyx ${status} on ${path}: ${body.slice(0, 500)}`);
  }
}

/** For deletes: an object that is already gone counts as deleted. */
async function ignoreNotFound(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof TelnyxApiError && err.status === 404)) throw err;
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

  async function request(method: string, path: string, body?: unknown, accept = "application/json"): Promise<Response> {
    const isForm = body instanceof FormData;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: accept,
        ...(body && !isForm ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      // Unverified (pre-L2) accounts can clone voices but not use them in assistants or TTS.
      if (res.status === 403 && /cloned voices/i.test(text)) {
        throw new FeatureNotPermittedError("cloned_voices", `Telnyx 403 on ${path}: ${text.slice(0, 500)}`);
      }
      throw new TelnyxApiError(res.status, text, path);
    }
    return res;
  }

  async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const text = await (await request(method, path, body)).text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function audio(res: Response): Promise<PreviewAudio> {
    return { audio: await res.arrayBuffer(), contentType: res.headers.get("content-type")?.split(";")[0] || "audio/mpeg" };
  }

  // The catalog is large (~1,300 voices) and rarely changes; cache it per process.
  const VOICE_CACHE_MS = 60 * 60 * 1000;
  let voiceCache: { at: number; voices: StockVoice[] } | undefined;
  let modelCache: { at: number; models: LlmModel[] } | undefined;

  const action = (ccid: string, cmd: string, body: Record<string, unknown> = {}) =>
    api("POST", `/calls/${encodeURIComponent(ccid)}/actions/${cmd}`, body);

  const recordOpts = { record: "record-from-answer", record_format: "mp3", record_channels: "dual" };

  function assistantBody(spec: AssistantSpec) {
    const b = spec.behavior;
    const tools: Record<string, unknown>[] = [];
    if (b.endCallWhenDone) tools.push({ type: "hangup", hangup: { description: HANGUP_TOOL_DESCRIPTION } });
    if (spec.knowledgeBucket) {
      tools.push({ type: "retrieval", retrieval: { bucket_ids: [spec.knowledgeBucket], max_num_results: KNOWLEDGE_RESULTS } });
    }
    return {
      name: spec.name,
      instructions: spec.instructions,
      greeting: spec.greeting,
      model: spec.model,
      voice_settings: {
        voice: spec.voiceRef,
        ...(spec.voiceApiKeyRef ? { api_key_ref: spec.voiceApiKeyRef } : {}),
        // ElevenLabs voices take their own `speed`; Telnyx voices use voice_speed.
        ...(isElevenLabsVoice(spec.voiceRef) ? { speed: b.voiceSpeed } : { voice_speed: b.voiceSpeed }),
        background_audio: { type: "predefined_media", value: b.backgroundSound === "office" ? "office" : "silence", volume: 0.5 },
      },
      transcription: {
        model: cfg.sttModel,
        // "auto" tolerates EN/ZH mixing; fall back to the agent's primary language otherwise.
        language: cfg.sttLanguage === "primary" ? spec.language : cfg.sttLanguage,
        settings: { keyterm: b.keyTerms || null },
      },
      interruption_settings: {
        enable: b.allowInterruptions,
        disable_greeting_interruption: !b.greetingInterruptible,
        start_speaking_plan: { wait_seconds: RESPONSE_TIMING[b.responseTiming] },
      },
      // Defaults for the variables we fill in on every call (see assistantStart in calls/events.ts),
      // plus the agent's own.
      dynamic_variables: { call_direction: "inbound", call_goal: "", contact_number: "", current_time: "", ...spec.variables },
      // Always sent: an omitted `tools` keeps whatever the assistant had, so removing a tool needs the
      // full list. Our assistants have no tools other than these.
      tools,
      enabled_features: ["telephony"],
      privacy_settings: { data_retention: true },
      telephony_settings: {
        time_limit_secs: b.maxCallMinutes * 60,
        // null clears a timeout set earlier.
        user_idle_timeout_secs: b.silenceHangupSecs || null,
        // Calls are recorded by our answer/dial commands. The assistant's own recording is on by
        // default and produced a second, duplicate recording on outbound calls.
        recording_settings: { enabled: false },
      },
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
      // The order item id is not the phone-number resource id; look that up. Until it shows up (or if
      // the lookup fails) report the order as pending, so it is polled again rather than activated
      // without an id we could later release.
      numberId = (await findNumber(e164).catch((err) => console.error("number lookup failed", e164, err))) ?? undefined;
    }
    return {
      orderId: order.id,
      status: status === "success" && !numberId ? "pending" : status,
      numberId,
      failureReason: status === "failure" ? orderFailureReason(order.status) : undefined,
    };
  }

  /** Telnyx's status is an English enum ("failure", "cancelled", "deleted"): say what it means instead. */
  function orderFailureReason(status: string) {
    console.warn("number order ended as", status);
    return status === "failure" ? stored("numberOrderRejected") : stored("numberOrderCancelled");
  }

  async function findNumber(e164: string): Promise<string | null> {
    const list = await api<{ data: { id: string }[] }>("GET", `/phone_numbers?filter[phone_number]=${encodeURIComponent(e164)}`);
    return list.data[0]?.id ?? null;
  }

  function toClone(d: { id: string; status: string; provider_voice_id?: string; model_id?: string }): ClonedVoiceResult {
    const model = d.model_id ?? cfg.cloneModel;
    return {
      voiceId: d.id,
      ref: `Telnyx.${model}.${d.provider_voice_id ?? d.id}`,
      status: d.status === "active" ? "ready" : d.status === "pending" ? "processing" : "failed",
      failureReason: d.status === "expired" ? stored("voiceExpired") : d.status === "failed" ? stored("voiceCloningFailed") : undefined,
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

  const storage = createStorageClient(cfg.apiKey);

  /**
   * Per-file statuses aren't enumerated in the docs. In the portal spike the status stayed blank for
   * files that were embedded (docs/telnyx-api-notes.md §15), so only explicit progress words mean
   * "still processing"; a file that is listed with any other status is done.
   */
  function toEmbeddingStatus(status: string | undefined): EmbeddingStatus {
    const s = (status ?? "").toLowerCase();
    if (/fail|error/.test(s)) return "failed";
    if (/queue|pending|process|progress|running/.test(s)) return "processing";
    return "ready";
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
        // Without best_effort, Telnyx answers 400 (10031) when it can't fill the limit
        // with exact matches; with it, it tops up with numbers from nearby area codes.
        "filter[best_effort]": "true",
      });
      // New numbers receive texts (SPEC §17.3), which a voice-only number never could.
      if (cfg.messagingProfileId) q.append("filter[features][]", "sms");
      if (areaCode) q.set("filter[national_destination_code]", areaCode);
      let res: { data: { phone_number: string; best_effort?: boolean; region_information?: { region_type: string; region_name: string }[] }[] };
      try {
        res = await api("GET", `/available_phone_numbers?${q}`);
      } catch (err) {
        if (err instanceof TelnyxApiError && err.status === 400 && err.body.includes("10031")) return [];
        throw err;
      }
      return res.data
        .map((n) => ({
          e164: n.phone_number,
          locality: n.region_information?.find((r) => r.region_type === "rate_center")?.region_name,
          region: n.region_information?.find((r) => r.region_type === "state")?.region_name,
          nearby: Boolean(n.best_effort),
        }))
        .sort((a, b) => Number(a.nearby) - Number(b.nearby));
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

    findNumber,

    async releaseNumber(numberId) {
      await ignoreNotFound(api("DELETE", `/phone_numbers/${encodeURIComponent(numberId)}`));
    },

    async enableInboundMessaging(e164) {
      if (!cfg.messagingProfileId) throw new Error("TELNYX_MESSAGING_PROFILE_ID is not set");
      await api("PATCH", `/messaging_phone_numbers/${encodeURIComponent(e164)}`, {
        messaging_profile_id: cfg.messagingProfileId,
      });
    },

    async listStockVoices() {
      if (voiceCache && Date.now() - voiceCache.at < VOICE_CACHE_MS) return voiceCache.voices;
      try {
        // Unlike most endpoints this one isn't wrapped in `data`.
        const res = await api<{ voices: CatalogVoice[] }>("GET", "/text-to-speech/voices?provider=telnyx");
        voiceCache = { at: Date.now(), voices: toStockVoices(res.voices) };
      } catch (err) {
        // An outdated catalog beats none: agent pages still load and agents can still be saved.
        if (!voiceCache) throw err;
        console.error("voice catalog refresh failed; using the cached one", err);
      }
      return voiceCache.voices;
    },

    async synthesizePreview(voiceRef, text) {
      return audio(await request("POST", "/text-to-speech/speech", { text, voice: voiceRef }, "audio/mpeg"));
    },

    async getCloneSample(voiceId) {
      // This endpoint answers 406 to any Accept but */* (even audio/wav, which it returns).
      return audio(await request("GET", `/voice_clones/${encodeURIComponent(voiceId)}/sample`, undefined, "*/*"));
    },

    async listModels() {
      if (modelCache && Date.now() - modelCache.at < VOICE_CACHE_MS) return modelCache.models;
      try {
        const res = await api<{ data: CatalogModel[] }>("GET", "/ai/models");
        modelCache = { at: Date.now(), models: toOfferedModels(res.data) };
      } catch (err) {
        if (!modelCache) throw err;
        console.error("model catalog refresh failed; using the cached one", err);
      }
      return modelCache.models;
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
      // Docs mention GET /voice_clones/{id} but the OpenAPI spec only defines it on the list
      // endpoint, so fall back to scanning the list.
      try {
        const res = await api<{ data: Parameters<typeof toClone>[0] }>("GET", `/voice_clones/${encodeURIComponent(voiceId)}`);
        return toClone(res.data);
      } catch (err) {
        if (!(err instanceof TelnyxApiError) || ![404, 405].includes(err.status)) throw err;
      }
      const list = await api<{ data: Parameters<typeof toClone>[0][] }>("GET", "/voice_clones?page[size]=250");
      const found = list.data.find((c) => c.id === voiceId);
      return found ? toClone(found) : { voiceId, ref: "", status: "failed", failureReason: stored("voiceUnavailable") };
    },

    async deleteClonedVoice(voiceId) {
      await api("DELETE", `/voice_clones/${encodeURIComponent(voiceId)}`);
    },

    async createIntegrationSecret(identifier, token) {
      const res = await api<{ data: { id: string } }>("POST", "/integration_secrets", { identifier, type: "bearer", token });
      return { id: res.data.id };
    },

    async deleteIntegrationSecret(id) {
      await ignoreNotFound(api("DELETE", `/integration_secrets/${encodeURIComponent(id)}`));
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
      await ignoreNotFound(api("DELETE", `/ai/assistants/${encodeURIComponent(assistantId)}?hard_delete=true`));
    },

    createBucket: (bucket) => storage.createBucket(bucket),

    async enableEmbedding(bucket) {
      await api("POST", "/ai/embeddings", { bucket_name: bucket });
    },

    putObject: (bucket, key, body, contentType) => storage.putObject(bucket, key, body, contentType),
    listObjects: (bucket) => storage.listObjects(bucket),
    deleteObject: (bucket, key) => storage.deleteObject(bucket, key),

    async embeddingStatuses(bucket) {
      try {
        const res = await api<{ data: { filename: string; status?: string }[] }>("GET", `/ai/embeddings/buckets/${encodeURIComponent(bucket)}`);
        return new Map(res.data.map((f) => [f.filename, toEmbeddingStatus(f.status)]));
      } catch (err) {
        // Nothing embedded yet.
        if (err instanceof TelnyxApiError && err.status === 404) return new Map();
        throw err;
      }
    },

    async crawlUrl(bucket, url) {
      const res = await api<{ data: { task_id: string } }>("POST", "/ai/embeddings/url", { url, bucket_name: bucket });
      return { taskId: res.data.task_id };
    },

    async deleteBucket(bucket) {
      await ignoreNotFound(api("DELETE", `/ai/embeddings/buckets/${encodeURIComponent(bucket)}`));
      await storage.deleteBucket(bucket);
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
      // The stored assistant already carries voice/greeting; per-call voice overrides would
      // replace (not merge) voice_settings, so only id + dynamic variables (which merge) are sent.
      await action(ccid, "answer", {
        client_state: encodeClientState(clientState),
        command_id: `${clientState}:answer`,
        assistant: { id: assistant.assistantId, dynamic_variables: assistant.variables },
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
        {
          assistant: { id: assistant.assistantId, dynamic_variables: assistant.variables },
          ...(assistant.greetingOverride ? { greeting: assistant.greetingOverride } : {}),
          command_id: `${ccid}:assistant`,
        },
      );
      return { conversationId: res.data?.conversation_id };
    },

    async getCallResults(ref) {
      const conversationId = await findConversationId(ref);
      if (!conversationId) return null;
      // Telnyx caps page[size] at 100 (larger sizes are rejected with 10015), so page through.
      type Msg = { role: string; text?: string; sent_at?: string; created_at?: string };
      const all: Msg[] = [];
      for (let page = 1; page <= MAX_MESSAGE_PAGES; page++) {
        const res = await api<{ data: Msg[]; meta?: { total_pages?: number } }>(
          "GET",
          `/ai/conversations/${encodeURIComponent(conversationId)}/messages?page[size]=100&page[number]=${page}`,
        );
        all.push(...res.data);
        if (page >= (res.meta?.total_pages ?? 1)) break;
      }
      const transcript = all
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.text)
        .sort((a, b) => (a.sent_at ?? a.created_at ?? "").localeCompare(b.sent_at ?? b.created_at ?? ""))
        .map((m) => ({ role: m.role, text: m.text! }));

      let summary: string | undefined;
      let summaryPending = false;
      if (cfg.insightGroupId) {
        const ins = await api<{ data: { status: string; conversation_insights?: { result: string }[] }[] }>(
          "GET",
          `/ai/conversations/${encodeURIComponent(conversationId)}/conversations-insights`,
        );
        const done = ins.data.find((i) => i.status === "completed");
        // Still being generated: the transcript is returned anyway, and the summary is fetched again later.
        summaryPending = !done && ins.data.some((i) => i.status === "pending" || i.status === "in_progress");
        summary = done?.conversation_insights?.[0]?.result;
      }
      return { transcript, summary, summaryPending };
    },

    async getRecordingUrl(ref) {
      const recs = await listRecordings(ref);
      return recs[0]?.download_urls?.mp3 ?? recs[0]?.download_urls?.wav ?? null;
    },

    async purgeCallData(ref) {
      // Already-deleted objects count as deleted, so a purge that half-succeeded (or ran twice) can finish.
      for (const r of await listRecordings(ref)) await ignoreNotFound(api("DELETE", `/recordings/${encodeURIComponent(r.id)}`));
      const conversationId = await findConversationId(ref);
      if (conversationId) await ignoreNotFound(api("DELETE", `/ai/conversations/${encodeURIComponent(conversationId)}`));
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
