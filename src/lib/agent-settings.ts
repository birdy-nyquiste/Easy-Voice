import { z } from "zod";

/** Seconds the agent waits after the caller stops before it replies (Telnyx start_speaking_plan.wait_seconds). */
export const RESPONSE_TIMING = { quick: 0.4, balanced: 0.8, patient: 1.2 } as const;
export type ResponseTiming = keyof typeof RESPONSE_TIMING;

export const MAX_CALL_MINUTES = [5, 10, 15, 30] as const;
/** 0 means the agent never hangs up because of silence. */
export const SILENCE_HANGUP_SECS = [0, 30, 60] as const;
export const VOICE_SPEED = { min: 0.8, max: 1.2, step: 0.05 } as const;
export const MAX_KEY_TERMS_LENGTH = 1000;
export const DEFAULT_TIME_ZONE = "America/New_York";

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const oneOf = (values: readonly number[], fallback: number) =>
  z.coerce
    .number()
    .refine((n) => values.includes(n))
    .catch(fallback);

/**
 * How an agent behaves on calls, beyond its script and voice. Stored as one JSON column; a missing
 * or invalid field reads back as its default, so agents saved before a field existed stay complete.
 */
export const agentBehavior = z.object({
  voiceSpeed: z.coerce.number().min(VOICE_SPEED.min).max(VOICE_SPEED.max).catch(1),
  backgroundSound: z.enum(["none", "office"]).catch("none"),
  responseTiming: z.enum(["quick", "balanced", "patient"]).catch("quick"),
  allowInterruptions: z.boolean().catch(true),
  greetingInterruptible: z.boolean().catch(true),
  /** Comma-separated words speech recognition should listen for (names, jargon). */
  keyTerms: z.string().trim().max(MAX_KEY_TERMS_LENGTH).catch(""),
  endCallWhenDone: z.boolean().catch(true),
  maxCallMinutes: oneOf(MAX_CALL_MINUTES, 30),
  silenceHangupSecs: oneOf(SILENCE_HANGUP_SECS, 60),
  /** IANA zone {{current_time}} is given in. */
  timeZone: z.string().refine(isTimeZone).catch(DEFAULT_TIME_ZONE),
});
export type AgentBehavior = z.infer<typeof agentBehavior>;

export const DEFAULT_BEHAVIOR: AgentBehavior = agentBehavior.parse({});

/** Read a stored behavior column, filling in defaults for anything missing or no longer valid. */
export function readBehavior(raw: unknown): AgentBehavior {
  return agentBehavior.parse(raw && typeof raw === "object" ? raw : {});
}

/** Variables every call gets, filled in by us when the call starts. */
export const BUILT_IN_VARIABLES = ["call_direction", "call_goal", "contact_number", "current_time"] as const;
export type BuiltInVariable = (typeof BUILT_IN_VARIABLES)[number];

export const MAX_VARIABLES = 10;
export const MAX_VARIABLE_VALUE_LENGTH = 500;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** Why a custom variable key can't be used, or null if it can. */
export function variableKeyProblem(key: string): "format" | "reserved" | null {
  if (!KEY.test(key)) return "format";
  if ((BUILT_IN_VARIABLES as readonly string[]).includes(key) || key.startsWith("telnyx_")) return "reserved";
  return null;
}

export const agentVariable = z.object({
  key: z.string().trim(),
  value: z.string().trim().max(MAX_VARIABLE_VALUE_LENGTH).default(""),
  /** Ask for this variable's value each time the user places a call. */
  askPerCall: z.boolean().default(false),
});
export type AgentVariable = z.infer<typeof agentVariable>;

export function readVariables(raw: unknown): AgentVariable[] {
  const r = z.array(agentVariable).safeParse(raw);
  return r.success ? r.data : [];
}

/** Names used as {{name}} in a script, in order of first use. Filters ({{ x | date: … }}) count as x. */
export function referencedVariables(...texts: string[]): string[] {
  const names = texts.flatMap((t) => [...t.matchAll(/\{\{\s*([A-Za-z_][\w/]*)/g)].map((m) => m[1]));
  return [...new Set(names)];
}

/** Variables a script uses that nobody fills in, so the agent would see "{{name}}" literally. */
export function undefinedVariables(texts: string[], variables: Pick<AgentVariable, "key">[]): string[] {
  const known = new Set<string>([...BUILT_IN_VARIABLES, ...variables.map((v) => v.key)]);
  return referencedVariables(...texts).filter((n) => !known.has(n) && !n.startsWith("telnyx_"));
}

/** {{current_time}} for a call: e.g. "Wednesday, October 21, 2026, 10:48 AM EDT". */
export function currentTimeText(timeZone: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}
