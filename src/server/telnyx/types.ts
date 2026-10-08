import type { Language } from "@/lib/language";

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
  failureReason?: string;
}

export interface StockVoice {
  /** Value used directly as the assistant voice. */
  ref: string;
  name: string;
  language: string; // BCP-47-ish, e.g. "en-US", "zh-CN"
  gender?: string;
  provider?: string;
}

export interface ClonedVoiceResult {
  voiceId: string;
  /** Value used as the assistant voice. */
  ref: string;
  status: "processing" | "ready" | "failed";
  failureReason?: string;
}

export interface AssistantSpec {
  name: string;
  instructions: string;
  greeting: string;
  language: Language;
  voiceRef: string;
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

/**
 * Per-call values available to an agent's instructions as {{call_direction}} and {{call_goal}}.
 */
export interface CallVariables {
  call_direction: "inbound" | "outbound";
  /** What the user asked the agent to do on this call (outbound only; may be empty). */
  call_goal: string;
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
  releaseNumber(numberId: string): Promise<void>;

  listStockVoices(): Promise<StockVoice[]>;
  /** Max accepted sample size in bytes. */
  readonly maxCloneSampleBytes: number;
  cloneVoice(input: { name: string; language: Language; gender: "male" | "female"; audio: Blob }): Promise<ClonedVoiceResult>;
  getClonedVoice(voiceId: string): Promise<ClonedVoiceResult>;
  deleteClonedVoice(voiceId: string): Promise<void>;

  createAssistant(spec: AssistantSpec): Promise<{ assistantId: string }>;
  updateAssistant(assistantId: string, spec: AssistantSpec): Promise<void>;
  deleteAssistant(assistantId: string): Promise<void>;

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
  parseWebhook(rawBody: string, headers: Headers): Promise<CallEvent>;
}
