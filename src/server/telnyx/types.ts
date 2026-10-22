import type { AgentBehavior } from "@/lib/agent-settings";
import type { Language } from "@/lib/language";
import type { StoredText } from "@/lib/stored-text";

/**
 * Provider-neutral voice platform interface. Business code depends on this,
 * never on Telnyx request/response shapes (SPEC §3.8).
 */

export interface AvailableNumber {
  e164: string;
  locality?: string;
  region?: string;
  /** Not in the requested area code; offered as a nearby alternative. */
  nearby?: boolean;
}

export type OrderStatus = "pending" | "success" | "failure";

export interface NumberOrderResult {
  orderId: string;
  status: OrderStatus;
  numberId?: string;
  failureReason?: StoredText;
}

export interface StockVoice {
  /** Value used directly as the assistant voice. */
  ref: string;
  name: string;
  language: string; // BCP-47-ish, e.g. "en-US", "zh-CN"
  /** Languages this voice can actually pronounce. */
  speaks: Language[];
  gender?: string;
  provider?: string;
}

export interface LlmModel {
  /** Value sent as the assistant's model. */
  id: string;
  name: string;
  /** USD per 1M tokens. */
  inputPricePerM: number;
  outputPricePerM: number;
}

export interface PreviewAudio {
  audio: ArrayBuffer;
  contentType: string;
}

/** A provider answered an HTTP request with an error status. */
export class ProviderHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Whether a failed request certainly did nothing: the provider refused it (4xx). Timeouts, network
 * errors, 5xx, 408 and 429 leave it unknown whether the request was applied.
 */
export function isDefiniteRejection(err: unknown): boolean {
  return err instanceof ProviderHttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/** The provider account isn't allowed to use a feature (e.g. cloned voices before verification). */
export class FeatureNotPermittedError extends Error {
  name = "FeatureNotPermittedError";
  constructor(
    public feature: "cloned_voices",
    detail: string,
  ) {
    super(detail);
  }
}

export interface ClonedVoiceResult {
  voiceId: string;
  /** Value used as the assistant voice. */
  ref: string;
  status: "processing" | "ready" | "failed";
  failureReason?: StoredText;
}

export interface AssistantSpec {
  name: string;
  instructions: string;
  greeting: string;
  language: Language;
  voiceRef: string;
  /** Integration secret identifier holding the user's key, for voices on their own provider account (ElevenLabs). */
  voiceApiKeyRef?: string;
  /** LLM id; see listModels(). */
  model: string;
  /** Voice speed, turn-taking and when the assistant hangs up. */
  behavior: AgentBehavior;
  /** Default values for the agent's own {{variables}}; built-in ones are added by the adapter. */
  variables: Record<string, string>;
  /** Storage bucket the assistant may search during calls (the retrieval tool); none when absent. */
  knowledgeBucket?: string;
}

/** Embedding progress of one object in a knowledge bucket. */
export type EmbeddingStatus = "processing" | "ready" | "failed";

export interface StoredObject {
  key: string;
  sizeBytes: number;
  modifiedAt: Date;
}

export interface DialResult {
  callControlId: string;
  callSessionId?: string;
}

export interface CallResults {
  transcript: { role: string; text: string }[];
  summary?: string;
}

export type CallEventType =
  | "call.initiated"
  | "call.answered"
  | "call.hangup"
  | "call.recording.saved"
  | "call.conversation.created"
  | "call.conversation.start_failed"
  | "call.cost"
  | "other";

export interface CallEvent {
  /** Provider event id, used for dedupe. */
  id: string;
  type: CallEventType;
  rawType: string;
  occurredAt: Date;
  callControlId?: string;
  callSessionId?: string;
  direction?: "inbound" | "outbound";
  from?: string;
  to?: string;
  /** Decoded client_state (we always send our call id). */
  clientState?: string;
  hangupCause?: string;
  startTime?: Date;
  endTime?: Date;
  conversationId?: string;
  failureReason?: string;
  /** call.cost: provider's total cost in USD, as sent (decimal string). */
  totalCostUsd?: string;
}

/** A text that arrived at one of our numbers (message.received). We never send texts. */
export interface InboundMessageEvent {
  /** Provider event id, used for dedupe. */
  id: string;
  type: "message.received";
  rawType: string;
  occurredAt: Date;
  messageId: string;
  from: string;
  /** Our number the text was sent to. */
  to: string;
  text: string;
  /** SMS segments. */
  parts: number;
  mediaCount: number;
  /** Provider cost in USD, as sent (decimal string), when present. */
  costUsd?: string;
}

export type ProviderEvent = CallEvent | InboundMessageEvent;

/**
 * Per-call values available to an agent's instructions as {{call_direction}} and {{call_goal}}.
 */
export interface CallVariables {
  call_direction: "inbound" | "outbound";
  /** What the user asked the agent to do on this call (outbound only; may be empty). */
  call_goal: string;
  /** The other party's number: the caller on inbound calls, the number called on outbound ones. */
  contact_number: string;
  /** When the call started, in the agent's time zone. */
  current_time: string;
  /** The agent's own variables. */
  [key: string]: string;
}

export interface AssistantStart {
  assistantId: string;
  voiceRef: string;
  variables: CallVariables;
  /** Replaces the stored greeting for this call only (used for outbound calls). */
  greetingOverride?: string;
}

export interface CallRef {
  callControlId: string;
  callSessionId?: string | null;
  conversationId?: string | null;
}

export interface VoiceProvider {
  readonly name: string;

  searchNumbers(q: { areaCode?: string; limit?: number }): Promise<AvailableNumber[]>;
  orderNumber(e164: string): Promise<NumberOrderResult>;
  getNumberOrder(orderId: string): Promise<NumberOrderResult>;
  /** The provider's id for a number on our account, or null if we don't have it. */
  findNumber(e164: string): Promise<string | null>;
  /** Succeeds if the number is already gone. */
  releaseNumber(numberId: string): Promise<void>;
  /** Put a number on the platform messaging profile so it can receive texts. Idempotent. */
  enableInboundMessaging(e164: string): Promise<void>;

  listStockVoices(): Promise<StockVoice[]>;
  /** Speak `text` with a catalog voice (the voice ref as used by assistants). */
  synthesizePreview(voiceRef: string, text: string): Promise<PreviewAudio>;
  /** The audio a clone was made from. */
  getCloneSample(voiceId: string): Promise<PreviewAudio>;
  /** LLMs offered for agents (see models.ts for the selection rules). */
  listModels(): Promise<LlmModel[]>;
  /** Max accepted sample size in bytes. */
  readonly maxCloneSampleBytes: number;
  cloneVoice(input: { name: string; language: Language; gender: "male" | "female"; audio: Blob }): Promise<ClonedVoiceResult>;
  getClonedVoice(voiceId: string): Promise<ClonedVoiceResult>;
  deleteClonedVoice(voiceId: string): Promise<void>;

  /** Store a third-party API key so assistants can reference it by `identifier` (e.g. voice api_key_ref). */
  createIntegrationSecret(identifier: string, token: string): Promise<{ id: string }>;
  /** Succeeds if the secret is already gone. */
  deleteIntegrationSecret(id: string): Promise<void>;

  createAssistant(spec: AssistantSpec): Promise<{ assistantId: string }>;
  updateAssistant(assistantId: string, spec: AssistantSpec): Promise<void>;
  deleteAssistant(assistantId: string): Promise<void>;

  /** Create a knowledge storage bucket (versioning off). Succeeds if we already own it. */
  createBucket(bucket: string): Promise<void>;
  /** Turn on embedding; objects added afterwards are embedded automatically. */
  enableEmbedding(bucket: string): Promise<void>;
  putObject(bucket: string, key: string, body: Blob, contentType: string): Promise<void>;
  listObjects(bucket: string): Promise<StoredObject[]>;
  /** Succeeds if the object is already gone. */
  deleteObject(bucket: string, key: string): Promise<void>;
  /** Embedding status by object key; objects not listed yet are still processing. */
  embeddingStatuses(bucket: string): Promise<Map<string, EmbeddingStatus>>;
  /**
   * Crawl a website into the bucket (same-domain pages, embedded as they arrive). There is no way to
   * tell when a crawl has finished: its task reports success at once (docs/telnyx-api-notes.md §17).
   */
  crawlUrl(bucket: string, url: string): Promise<{ taskId: string }>;
  /** Turn embedding off, then delete the (empty) bucket. Succeeds if it is already gone. */
  deleteBucket(bucket: string): Promise<void>;

  /** Dials with recording on; start the assistant on call.answered. */
  dial(input: { from: string; to: string; clientState: string }): Promise<DialResult>;
  /** Answers with recording on and starts the assistant in one step. */
  answer(callControlId: string, clientState: string, assistant: AssistantStart): Promise<void>;
  reject(callControlId: string, cause: "CALL_REJECTED" | "USER_BUSY"): Promise<void>;
  hangup(callControlId: string): Promise<void>;
  startAssistant(callControlId: string, input: AssistantStart): Promise<{ conversationId?: string }>;
  /** Null when results aren't available (yet). */
  getCallResults(call: CallRef): Promise<CallResults | null>;
  /** Short-lived playback URL, or null if no recording exists. */
  getRecordingUrl(call: CallRef): Promise<string | null>;
  /** Delete recordings and the AI conversation (transcript, insights) at the provider. */
  purgeCallData(call: CallRef): Promise<void>;

  /** Verify signature and parse; throws on invalid signature. */
  parseWebhook(rawBody: string, headers: Headers): Promise<ProviderEvent>;
}
