import type { CallEvent, CallEventType } from "./types";

const KNOWN: CallEventType[] = [
  "call.initiated",
  "call.answered",
  "call.hangup",
  "call.recording.saved",
  "call.conversation.created",
  "call.conversation.start_failed",
];

function date(v: unknown): Date | undefined {
  return typeof v === "string" && v ? new Date(v) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function decodeClientState(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  try {
    return Buffer.from(s, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

export function encodeClientState(v: string): string {
  return Buffer.from(v, "utf8").toString("base64");
}

/**
 * Normalize a Telnyx v2 webhook envelope. Note: call.hangup carries no end_time
 * (use occurredAt) and call.recording.saved has no call_control_id.
 */
export function parseTelnyxEnvelope(body: unknown): CallEvent {
  const data = (body as { data?: Record<string, unknown> })?.data;
  if (!data || typeof data !== "object") throw new Error("Malformed webhook: missing data");
  const rawType = str(data.event_type) ?? "unknown";
  const p = (data.payload ?? {}) as Record<string, unknown>;
  return {
    id: str(data.id) ?? `${rawType}:${str(p.call_control_id) ?? ""}:${str(data.occurred_at) ?? ""}`,
    type: (KNOWN as string[]).includes(rawType) ? (rawType as CallEventType) : "other",
    rawType,
    occurredAt: date(data.occurred_at) ?? new Date(),
    callControlId: str(p.call_control_id),
    callSessionId: str(p.call_session_id),
    direction: p.direction === "incoming" || p.direction === "inbound" ? "inbound" : p.direction ? "outbound" : undefined,
    from: str(p.from),
    to: str(p.to),
    clientState: decodeClientState(p.client_state),
    hangupCause: str(p.hangup_cause),
    startTime: date(p.start_time),
    endTime: date(p.end_time),
    conversationId: str(p.conversation_id),
    failureReason: str(p.reason),
  };
}
