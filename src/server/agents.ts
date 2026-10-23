import "server-only";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withUserLock } from "@/db";
import { agentKnowledge, agents, elevenLabsKeys, knowledgeSources, phoneNumbers, type Agent, type KnowledgeMode } from "@/db/schema";
import {
  agentVariable,
  MAX_KEY_TERMS_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  MAX_VARIABLES,
  readBehavior,
  readVariables,
  variableKeyProblem,
  type AgentVariable,
} from "@/lib/agent-settings";
import { config } from "@/lib/config";
import { UserError, type ErrorKey } from "@/lib/errors";
import { failureColumns, stored, storedFromError } from "@/lib/stored-text";
import { LANGUAGES, type Language } from "@/lib/language";
import { isUuid } from "@/lib/uuid";
import { FeatureNotPermittedError, voiceProvider, type AssistantSpec } from "./telnyx";
import { isElevenLabsVoice, voiceSpeaks } from "./telnyx/stock-voices";
import { ASSISTANT_BODY_VERSION } from "./telnyx/version";
import { cloningAvailable, findOwnedClone, findStockVoice, parseVoiceValue } from "./voices";

export const RECORDING_NOTICE = {
  en: "This call may be recorded.",
  zh: "本次通话可能会被录音。",
} as const;

/**
 * Spoken first on calls the agent places: discloses that it's an AI and the recording,
 * then the agent pursues {{call_goal}} per its instructions. (The agent's own greeting is
 * written for answering calls, e.g. "you've reached my assistant".)
 */
export const OUTBOUND_GREETING = {
  en: `Hi, this is an AI assistant calling. ${RECORDING_NOTICE.en}`,
  zh: `您好，我是AI语音助理。${RECORDING_NOTICE.zh}`,
} as const;

export const MAX_CALL_GOAL_LENGTH = 1000;

const INPUT_ERRORS = {
  nameRequired: 1,
  instructionsRequired: 1,
  greetingRequired: 1,
  voiceRequired: 1,
  keyTermsTooLong: 1,
  tooManyVariables: 1,
} satisfies Partial<Record<ErrorKey, 1>>;

export const agentInput = z.object({
  name: z.string().trim().min(1, "nameRequired").max(80),
  instructions: z.string().trim().min(1, "instructionsRequired").max(8000),
  greeting: z.string().trim().min(1, "greetingRequired").max(500),
  language: z.enum(LANGUAGES),
  /** "stock:<ref>" or "clone:<voice uuid>" */
  voice: z.string().min(1, "voiceRequired"),
  /** LLM id from listModels(); empty means the platform default. */
  model: z.string().trim().optional().transform((m) => m || null),
  /** Anything missing or out of range falls back to its default (see agentBehavior). */
  behavior: z
    .looseObject({ keyTerms: z.string().trim().max(MAX_KEY_TERMS_LENGTH, "keyTermsTooLong").optional() })
    .default({})
    .transform(readBehavior),
  variables: z.array(agentVariable).max(MAX_VARIABLES, "tooManyVariables").default([]),
});
export type AgentInput = z.infer<typeof agentInput>;

export async function listUserAgents(userId: string): Promise<Agent[]> {
  // Ordered, or every save (a new row version) would reshuffle the list and the default outbound agent.
  return db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), isNull(agents.deletedAt)))
    .orderBy(agents.createdAt, agents.id);
}

export async function getUserAgent(userId: string, agentId: string): Promise<Agent | null> {
  if (!isUuid(agentId)) return null;
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId), isNull(agents.deletedAt)));
  return a ?? null;
}

async function resolveVoice(
  userId: string,
  voice: string,
  language: Language,
): Promise<{ voiceRef: string; voiceId: string | null }> {
  const parsed = parseVoiceValue(voice);
  if (parsed?.kind === "stock") {
    const match = await findStockVoice(parsed.value);
    if (!match) throw new UserError("unknownVoice");
    if (!match.speaks.includes(language)) {
      throw new UserError("voiceNoMandarin", { name: match.name });
    }
    return { voiceRef: match.ref, voiceId: null };
  }
  if (parsed?.kind === "clone") {
    const v = await findOwnedClone(userId, parsed.value);
    if (!v) throw new UserError("unknownVoice");
    if (!cloningAvailable(v.provider)) throw new UserError("cloningUnavailablePickBuiltIn");
    if (v.status !== "ready" || !v.voiceRef) throw new UserError("cloneNotReady");
    return { voiceRef: v.voiceRef, voiceId: v.id };
  }
  throw new UserError("unknownVoice");
}

export async function listModels() {
  return voiceProvider().listModels();
}

async function resolveModel(model: string | null): Promise<string | null> {
  if (!model || model === config.telnyx.llmModel) return null;
  if (!(await listModels()).some((m) => m.id === model)) throw new UserError("modelUnavailable");
  return model;
}

/** The greeting sent to the provider always starts with the recording notice (SPEC §16). */
export function providerGreeting(language: Language, greeting: string): string {
  const notice = RECORDING_NOTICE[language];
  return greeting.includes(notice) ? greeting : `${notice} ${greeting}`;
}

/** Appended for voices that can't pronounce Chinese, so replies stay speakable. */
export const ENGLISH_ONLY_VOICE_RULE =
  "Your voice can only speak English. Always reply in English, even if the caller speaks another language.";

/** Voices on the user's own ElevenLabs account need their key (as a Telnyx integration secret) on the assistant. */
async function voiceApiKeyRef(a: Pick<Agent, "userId" | "voiceRef">): Promise<string | undefined> {
  if (!isElevenLabsVoice(a.voiceRef)) return undefined;
  const [k] = await db
    .select({ ref: elevenLabsKeys.telnyxSecretRef })
    .from(elevenLabsKeys)
    .where(eq(elevenLabsKeys.userId, a.userId));
  if (!k) throw new UserError("elevenLabsNotConnectedForAgent");
  return k.ref;
}

/** What deleting clears at once: nothing from the source stays with us (SPEC §18.2). */
export const DELETED_SOURCE = {
  status: "deleting",
  name: null,
  content: null,
  url: null,
  sizeBytes: null,
  failureReason: null,
  failureMsg: null,
} as const;

/** Appended when the agent searches its knowledge base on calls (SPEC §18.2). */
export const KNOWLEDGE_RULES: Record<Exclude<KnowledgeMode, "off">, string> = {
  reference:
    "You can search a knowledge base with your owner's reference material. Prefer it for factual questions. " +
    "If it doesn't cover a question you may answer from general knowledge; if you aren't sure, say so and offer to pass the question on.",
  strict:
    "You can search a knowledge base with your owner's reference material. Answer factual questions only from the knowledge base, " +
    "these instructions and this call's goal. If none of them covers a question, say you don't know and offer to pass the question on. " +
    "This doesn't stop you from following your instructions and working toward the call's goal.",
};

/** What the assistant should have from the agent's knowledge base: a bucket to search and how to use it. */
export interface KnowledgeState {
  bucket: string;
  mode: Exclude<KnowledgeMode, "off">;
}

/**
 * The knowledge state each agent should have on the provider. An agent gets the retrieval tool when
 * the feature is on, its mode isn't off, embedding is on for its bucket, and no deleted source is still
 * being removed (so deleted content can't be quoted on a call).
 */
export async function desiredKnowledge(agentIds: string[]): Promise<Map<string, KnowledgeState>> {
  const out = new Map<string, KnowledgeState>();
  if (!config.features.knowledgeBase || !agentIds.length) return out;
  const kbs = await db.select().from(agentKnowledge).where(inArray(agentKnowledge.agentId, agentIds));
  const deleting = await db
    .selectDistinct({ agentId: knowledgeSources.agentId })
    .from(knowledgeSources)
    .where(and(inArray(knowledgeSources.agentId, agentIds), eq(knowledgeSources.status, "deleting")));
  const blocked = new Set(deleting.map((d) => d.agentId));
  for (const kb of kbs) {
    if (kb.mode === "off" || kb.status !== "ready" || !kb.embeddedAt || blocked.has(kb.agentId)) continue;
    out.set(kb.agentId, { bucket: kb.bucket, mode: kb.mode });
  }
  return out;
}

/** The agent's own variables with their default values. */
export function variableDefaults(a: Pick<Agent, "variables">): Record<string, string> {
  return Object.fromEntries(readVariables(a.variables).map((v) => [v.key, v.value]));
}

function toSpec(
  a: Pick<Agent, "name" | "instructions" | "greeting" | "language" | "voiceRef" | "model" | "behavior" | "variables">,
  voiceApiKeyRef?: string,
  knowledge?: KnowledgeState,
): AssistantSpec {
  const englishOnly = !voiceSpeaks(a.voiceRef).includes("zh");
  const rules = [englishOnly && ENGLISH_ONLY_VOICE_RULE, knowledge && KNOWLEDGE_RULES[knowledge.mode]].filter(Boolean);
  return {
    name: a.name,
    instructions: [a.instructions, ...rules].join("\n\n"),
    greeting: providerGreeting(a.language, a.greeting),
    language: a.language,
    voiceRef: a.voiceRef,
    voiceApiKeyRef,
    model: a.model ?? config.telnyx.llmModel,
    behavior: readBehavior(a.behavior),
    variables: variableDefaults(a),
    knowledgeBucket: knowledge?.bucket,
  };
}

export async function createAgent(userId: string, raw: unknown): Promise<Agent> {
  const input = parse(raw);
  const voice = await resolveVoice(userId, input.voice, input.language);
  input.model = await resolveModel(input.model);
  const row = await withUserLock(userId, async (tx) => {
    const existing = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.userId, userId), isNull(agents.deletedAt)));
    if (existing.length >= config.limits.agentsPerUser) {
      throw new UserError("agentLimit", { max: config.limits.agentsPerUser });
    }
    const [inserted] = await tx.insert(agents).values({ userId, ...input, ...voice, status: "syncing" }).returning();
    return inserted;
  });
  return syncAgent(row);
}

export async function updateAgent(userId: string, agentId: string, raw: unknown): Promise<Agent> {
  const existing = await getUserAgent(userId, agentId);
  if (!existing) throw new UserError("agentNotFound");
  const input = parse(raw);
  const voice = await resolveVoice(userId, input.voice, input.language);
  input.model = await resolveModel(input.model);
  const [row] = await db
    .update(agents)
    .set({ ...input, ...voice, status: "syncing", updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();
  return syncAgent(row);
}

async function agentRow(agentId: string): Promise<Agent | undefined> {
  const [a] = await db.select().from(agents).where(eq(agents.id, agentId));
  return a;
}

/**
 * The row is still the copy `a` was read from: every save sets updatedAt, and a deleted agent stays
 * deleted. (Postgres keeps microseconds, JS dates only milliseconds.)
 */
function unchangedSince(a: Agent) {
  return and(
    eq(agents.id, a.id),
    isNull(agents.deletedAt),
    sql`date_trunc('milliseconds', ${agents.updatedAt}) = ${a.updatedAt.toISOString()}::timestamptz`,
  );
}

/** Pushes per sync when the agent keeps changing while it is pushed. */
const MAX_PUSHES = 3;

/**
 * Push the agent and record that the provider has it. If the row changed while the push ran (a newer
 * save, or a background push of an older copy racing one), the newer row is pushed too: whichever
 * request lands last decides what the provider runs, so it must carry the latest config. Null when the
 * agent was deleted meanwhile.
 */
async function pushLatest(a: Agent, withKnowledge = true): Promise<Agent | null> {
  for (let pushes = 1; ; pushes++) {
    const knowledge = withKnowledge ? (await desiredKnowledge([a.id])).get(a.id) : undefined;
    const spec = toSpec(a, await voiceApiKeyRef(a), knowledge);
    let assistantId = a.providerAssistantId;
    if (assistantId) await voiceProvider().updateAssistant(assistantId, spec);
    else assistantId = (await voiceProvider().createAssistant(spec)).assistantId;
    const [u] = await db
      .update(agents)
      .set({ providerAssistantId: assistantId, status: "ready", failureReason: null, failureMsg: null, syncedConfig: agentFingerprint(knowledge) })
      .where(unchangedSince(a))
      .returning();
    if (u) return u;
    if (!a.providerAssistantId) {
      // Keep the new assistant's id anyway: the next push updates it, or the cleanup of deleted agents removes it.
      await db.update(agents).set({ providerAssistantId: assistantId }).where(and(eq(agents.id, a.id), isNull(agents.providerAssistantId)));
    }
    const latest = await agentRow(a.id);
    if (!latest || latest.deletedAt) return null;
    if (pushes === MAX_PUSHES) return latest;
    a = latest;
  }
}

/**
 * Re-push an agent after its knowledge base changed (mode, bucket, deletions), or to catch up a stale
 * one. Never records a failure: on failure the provider keeps the previous assistant and the
 * fingerprint stays stale, so it is retried later (SPEC §18.3). Returns whether it was pushed.
 */
export async function syncAgentQuietly(a: Agent): Promise<boolean> {
  try {
    return Boolean(await pushLatest(a));
  } catch (err) {
    console.error("syncAgentQuietly failed", a.id, err);
    return false;
  }
}

/** Push the agent config to the provider; records failure instead of throwing. */
export async function syncAgent(a: Agent): Promise<Agent> {
  try {
    try {
      return (await pushLatest(a)) ?? a;
    } catch (err) {
      if (!(await desiredKnowledge([a.id])).has(a.id)) throw err;
      // A knowledge-base problem must not fail the save: push without it. The stale fingerprint
      // shows the knowledge base as not applied yet, and it is retried later.
      console.error("syncAgent with knowledge failed; retrying without", a.id, err);
      return (await pushLatest(a, false)) ?? a;
    }
  } catch (err) {
    console.error("syncAgent failed", a.id, err);
    const reason = failureColumns(
      err instanceof FeatureNotPermittedError && err.feature === "cloned_voices"
        ? storedFromError(new UserError("cloningUnavailablePickBuiltIn"))
        : err instanceof UserError
          ? storedFromError(err)
          : stored("agentSaveFailed"),
    );
    // Only for the copy that failed: a newer save is synced (or fails) on its own.
    const [u] = await db
      .update(agents)
      .set({ status: "failed", ...reason })
      .where(unchangedSince(a))
      .returning();
    return u ?? (await agentRow(a.id)) ?? a;
  }
}

/**
 * Identifies the platform-wide assistant settings (models, insights, and the shape of
 * what we send). When these change on deploy, agents saved under the old settings are re-synced.
 */
export function platformFingerprint(): string {
  const t = config.telnyx;
  const settings = {
    body: ASSISTANT_BODY_VERSION,
    llm: t.llmModel,
    stt: t.sttModel,
    sttLanguage: t.sttLanguage,
    insights: t.insightGroupId,
  };
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 16);
}

/** What an agent's provider copy should match: the platform settings plus its knowledge state. */
export function agentFingerprint(knowledge?: KnowledgeState): string {
  const fp = platformFingerprint();
  if (!knowledge) return fp;
  return `${fp}:${createHash("sha256").update(JSON.stringify(knowledge)).digest("hex").slice(0, 16)}`;
}

/** Ready agents whose provider copy doesn't match the current settings and knowledge state. */
export async function staleAgents(userId?: string): Promise<Agent[]> {
  const ready = await db
    .select()
    .from(agents)
    .where(and(isNull(agents.deletedAt), eq(agents.status, "ready"), userId ? eq(agents.userId, userId) : undefined));
  const knowledge = await desiredKnowledge(ready.map((a) => a.id));
  return ready.filter((a) => a.syncedConfig !== agentFingerprint(knowledge.get(a.id)));
}

/**
 * A save still "syncing" after this was cut off before its push finished (the function timed out or
 * stopped); provider requests time out long before.
 */
const STUCK_SYNC_MS = 10 * 60 * 1000;

/**
 * Agents left in "syncing" by a save that never finished. Nothing else moves them out of it, and
 * calls are refused while an agent isn't ready.
 */
async function stuckAgents(userId?: string): Promise<Agent[]> {
  return db
    .select()
    .from(agents)
    .where(
      and(
        isNull(agents.deletedAt),
        eq(agents.status, "syncing"),
        lt(agents.updatedAt, new Date(Date.now() - STUCK_SYNC_MS)),
        userId ? eq(agents.userId, userId) : undefined,
      ),
    );
}

/**
 * Re-push agents whose provider copy is out of date, and finish saves that were cut off. Failures of
 * stale ones leave the agent as it is, to retry later.
 */
export async function resyncStaleAgents(userId?: string): Promise<number> {
  const stuck = await stuckAgents(userId);
  for (const a of stuck) await syncAgent(a);
  const stale = await staleAgents(userId);
  for (const a of stale) {
    // Read again: the list may be older than a save made since.
    const latest = await agentRow(a.id);
    if (latest?.status === "ready" && !latest.deletedAt) await syncAgentQuietly(latest);
  }
  return stuck.length + stale.length;
}

/**
 * resyncStaleAgents() when the user's agent pages are viewed, on the production deployment only.
 * Previews share its database and Telnyx account: if their page views synced too, each deployment
 * would push its own settings (fingerprint) over the other's, on every agent.
 */
export async function resyncStaleAgentsOnView(userId: string): Promise<number> {
  return config.isProductionDeployment ? resyncStaleAgents(userId) : 0;
}

/** Delete an assistant at the provider; false (logged) if that failed, to retry later. */
async function deleteAssistantQuietly(agentId: string, assistantId: string): Promise<boolean> {
  try {
    await voiceProvider().deleteAssistant(assistantId);
    return true;
  } catch (err) {
    console.error("deleteAssistant failed", agentId, err);
    return false;
  }
}

/**
 * Deleted agents whose assistant couldn't be deleted at the provider (they keep its id): try again,
 * so the agent's script doesn't stay there (SPEC §18.6). Run by the daily job.
 */
export async function deleteLeftoverAssistants(): Promise<number> {
  const leftover = await db
    .select({ id: agents.id, assistantId: agents.providerAssistantId })
    .from(agents)
    .where(and(isNotNull(agents.deletedAt), isNotNull(agents.providerAssistantId)));
  let deleted = 0;
  for (const { id, assistantId } of leftover) {
    if (!(await deleteAssistantQuietly(id, assistantId!))) continue;
    await db.update(agents).set({ providerAssistantId: null }).where(and(eq(agents.id, id), eq(agents.providerAssistantId, assistantId!)));
    deleted++;
  }
  return deleted;
}

export async function deleteAgent(userId: string, agentId: string): Promise<void> {
  const a = await getUserAgent(userId, agentId);
  if (!a) throw new UserError("agentNotFound");
  // The deletion goes ahead either way (SPEC §18.3). The assistant's id is kept only if it's still
  // there, for deleteLeftoverAssistants() to retry.
  const assistantGone = !a.providerAssistantId || (await deleteAssistantQuietly(a.id, a.providerAssistantId));
  await db.transaction(async (tx) => {
    await tx.update(phoneNumbers).set({ agentId: null }).where(eq(phoneNumbers.agentId, a.id));
    await tx
      .update(agents)
      .set({ deletedAt: new Date(), ...(assistantGone ? { providerAssistantId: null } : {}) })
      .where(eq(agents.id, a.id));
    // The knowledge base goes with the agent, permanently: clear what we hold now; the provider copy is
    // removed by cleanUpKnowledge() (SPEC §18.3). Whatever the feature flag says, but only where the
    // tables exist (previews run before the production migration).
    const [{ exists }] = (await tx.execute(sql`select to_regclass('public.knowledge_sources') is not null as exists`)) as unknown as {
      exists: boolean;
    }[];
    if (!exists) return;
    await tx.update(knowledgeSources).set(DELETED_SOURCE).where(eq(knowledgeSources.agentId, a.id));
    await tx.update(agentKnowledge).set({ status: "deleting" }).where(eq(agentKnowledge.agentId, a.id));
  });
}

function parse(raw: unknown): AgentInput {
  const r = agentInput.safeParse(raw);
  if (!r.success) {
    // Our own messages (above) are error keys; anything else zod reports gets a generic one.
    const message = r.error.issues[0]?.message;
    throw new UserError(message && message in INPUT_ERRORS ? (message as ErrorKey) : "invalidInput");
  }
  checkVariables(r.data.variables);
  return r.data;
}

function checkVariables(variables: AgentVariable[]) {
  const seen = new Set<string>();
  for (const { key, value, askPerCall } of variables) {
    const problem = variableKeyProblem(key);
    if (problem === "missing") throw new UserError("variableNameRequired");
    if (problem === "format") throw new UserError("variableKeyInvalid", { key });
    if (problem === "reserved") throw new UserError("variableKeyReserved", { key });
    if (seen.has(key)) throw new UserError("variableKeyDuplicate", { key });
    // A value asked for on each call may be left blank there; any other needs one here.
    if (!value && !askPerCall) throw new UserError("variableValueRequired", { key });
    if (value.length > MAX_VARIABLE_VALUE_LENGTH) throw new UserError("variableValueTooLong", { key, max: MAX_VARIABLE_VALUE_LENGTH });
    seen.add(key);
  }
}
