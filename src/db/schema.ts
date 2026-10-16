import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Language } from "@/lib/language";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------- Users & auth ----------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  googleSub: text("google_sub").unique(),
  /** Cached balance in US cents; only ever changed together with a ledger insert. */
  balanceCents: integer("balance_cents").notNull().default(0),
  /** When the balance first went negative; null while balance >= 0. */
  negativeSince: ts("negative_since"),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  /** sha256(token) — the raw token only lives in the cookie. */
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
});

export const emailOtps = pgTable(
  "email_otps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: ts("expires_at").notNull(),
    consumedAt: ts("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("email_otps_email_idx").on(t.email)],
);

// ---------- Billing ----------

export const paymentStatus = pgEnum("payment_status", ["pending", "succeeded", "failed"]);

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  provider: text("provider").notNull(), // "stripe"
  providerRef: text("provider_ref").notNull().unique(), // Stripe Checkout Session id
  amountCents: integer("amount_cents").notNull(),
  status: paymentStatus("status").notNull().default("pending"),
  failureReason: text("failure_reason"),
  createdAt: createdAt(),
  completedAt: ts("completed_at"),
});

export const ledgerKind = pgEnum("ledger_kind", [
  "topup",
  "call",
  "number_monthly",
  "voice_clone",
  "sms",
  "refund",
  "adjustment",
]);

/** Immutable record of every balance change. Sum(amount) per user == users.balance_cents. */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    amountCents: integer("amount_cents").notNull(), // + credit, - debit
    balanceAfterCents: integer("balance_after_cents").notNull(),
    kind: ledgerKind("kind").notNull(),
    /** Guarantees a charge/credit is applied once, e.g. "call:<id>", "stripe:<session>". */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    refType: text("ref_type"),
    refId: text("ref_id"),
    description: text("description").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("ledger_user_idx").on(t.userId, t.createdAt)],
);

// ---------- Resources ----------

export const numberStatus = pgEnum("number_status", ["pending", "active", "failed", "released"]);

export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    e164: text("e164").notNull(),
    providerOrderId: text("provider_order_id"),
    providerNumberId: text("provider_number_id"),
    status: numberStatus("status").notNull().default("pending"),
    failureReason: text("failure_reason"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** Monthly rental is paid up to this instant. */
    paidThrough: ts("paid_through"),
    /** When the number was put on the platform messaging profile (it can receive texts from then on). */
    smsEnabledAt: ts("sms_enabled_at"),
    createdAt: createdAt(),
    releasedAt: ts("released_at"),
  },
  (t) => [index("phone_numbers_e164_idx").on(t.e164), index("phone_numbers_user_idx").on(t.userId)],
);

export const voiceStatus = pgEnum("voice_status", ["processing", "ready", "failed"]);

/** Cloned voices owned by users. Stock voices come straight from the provider catalog. */
export const voices = pgTable("voices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  language: text("language").$type<Language>().notNull(),
  /** Provider clone id (for status/delete calls). */
  providerVoiceId: text("provider_voice_id"),
  /** Voice string used in assistant voice settings, e.g. "Telnyx.Qwen3TTS.<id>". */
  voiceRef: text("voice_ref"),
  status: voiceStatus("status").notNull().default("processing"),
  failureReason: text("failure_reason"),
  consentAt: ts("consent_at").notNull(),
  createdAt: createdAt(),
  deletedAt: ts("deleted_at"),
});

export const agentStatus = pgEnum("agent_status", ["syncing", "ready", "failed"]);

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  instructions: text("instructions").notNull(),
  greeting: text("greeting").notNull(),
  language: text("language").$type<Language>().notNull(),
  /** Provider voice identifier actually sent to the assistant. */
  voiceRef: text("voice_ref").notNull(),
  /** Set when the voice is one of the user's clones. */
  voiceId: uuid("voice_id").references(() => voices.id),
  /** LLM id; null means the platform default (config.telnyx.llmModel). */
  model: text("model"),
  providerAssistantId: text("provider_assistant_id"),
  /** Fingerprint of the platform model settings last pushed to the provider; see platformFingerprint(). */
  syncedConfig: text("synced_config"),
  status: agentStatus("status").notNull().default("syncing"),
  failureReason: text("failure_reason"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
});

// ---------- Calls ----------

export const callDirection = pgEnum("call_direction", ["inbound", "outbound"]);
export const callStatus = pgEnum("call_status", [
  "initiated",
  "answered",
  "completed",
  "rejected",
  "failed",
]);

export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    agentId: uuid("agent_id").references(() => agents.id),
    phoneNumberId: uuid("phone_number_id").references(() => phoneNumbers.id),
    direction: callDirection("direction").notNull(),
    fromNumber: text("from_number").notNull(),
    toNumber: text("to_number").notNull(),
    /** Outbound only: what the user asked the agent to do on this call ({{call_goal}}). */
    goal: text("goal"),
    providerCallControlId: text("provider_call_control_id").unique(),
    providerCallSessionId: text("provider_call_session_id"),
    providerConversationId: text("provider_conversation_id"),
    status: callStatus("status").notNull().default("initiated"),
    /** Human-readable explanation for rejected / failed / unanswered calls. */
    outcome: text("outcome"),
    hangupCause: text("hangup_cause"),
    answeredAt: ts("answered_at"),
    endedAt: ts("ended_at"),
    durationSec: integer("duration_sec"),
    billedCents: integer("billed_cents"),
    /** True when the call failed on our side (e.g. agent didn't start); no charge. */
    chargeWaived: boolean("charge_waived").notNull().default(false),
    /** Telnyx cost from the call.cost webhook, in micro-USD; reconciliation only, never billed. */
    providerCostMicros: integer("provider_cost_micros"),
    /** Provider recording URLs expire quickly, so we only remember that one exists and fetch on demand. */
    hasRecording: boolean("has_recording").notNull().default(false),
    transcript: jsonb("transcript").$type<{ role: string; text: string }[]>(),
    summary: text("summary"),
    resultsFetched: boolean("results_fetched").notNull().default(false),
    /** Set once recording/transcript/summary were deleted here and at the provider. */
    purgedAt: ts("purged_at"),
    createdAt: createdAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("calls_user_idx").on(t.userId, t.createdAt), index("calls_session_idx").on(t.providerCallSessionId)],
);

// ---------- Text messages (receive only; SPEC §17) ----------

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    phoneNumberId: uuid("phone_number_id").references(() => phoneNumbers.id),
    /** Sender: usually E.164, but short codes send texts too. */
    fromNumber: text("from_number").notNull(),
    toNumber: text("to_number").notNull(),
    /** Null once purged (retention or deleted by the user). */
    body: text("body"),
    /** SMS segments, as billed. */
    parts: integer("parts").notNull().default(1),
    /** MMS attachments are counted, never downloaded. */
    mediaCount: integer("media_count").notNull().default(0),
    providerMessageId: text("provider_message_id").notNull().unique(),
    billedCents: integer("billed_cents").notNull().default(0),
    /** Telnyx cost from the webhook, in micro-USD; reconciliation only. */
    providerCostMicros: integer("provider_cost_micros"),
    receivedAt: ts("received_at").notNull(),
    readAt: ts("read_at"),
    purgedAt: ts("purged_at"),
    createdAt: createdAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("messages_user_idx").on(t.userId, t.receivedAt)],
);

/** A user's own label for a number that texts them. */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    /** As it appears on messages.from_number. */
    number: text("number").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contacts_user_number_idx").on(t.userId, t.number)],
);

// ---------- Webhook dedupe ----------

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    receivedAt: createdAt(),
  },
  (t) => [uniqueIndex("webhook_events_provider_event_idx").on(t.provider, t.eventId)],
);

export type User = typeof users.$inferSelect;
export type PhoneNumber = typeof phoneNumbers.$inferSelect;
export type Voice = typeof voices.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Call = typeof calls.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
