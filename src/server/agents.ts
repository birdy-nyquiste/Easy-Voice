import "server-only";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withUserLock } from "@/db";
import { agentKnowledge, agents, elevenLabsKeys, knowledgeSources, phoneNumbers, voices, type Agent, type KnowledgeMode } from "@/db/schema";
import {
  agentVariable,
  MAX_KEY_TERMS_LENGTH,
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
import { FeatureNotPermittedError, voiceProvider, type AssistantSpec } from "./telnyx";
import { isElevenLabsVoice, voiceSpeaks } from "./telnyx/stock-voices";
import { ASSISTANT_BODY_VERSION } from "./telnyx/version";
import { cloningAvailable } from "./voices";

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
  return db.select().from(agents).where(and(eq(agents.userId, userId), isNull(agents.deletedAt)));
}

export async function getUserAgent(userId: string, agentId: string): Promise<Agent | null> {
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
  const [kind, value] = [voice.slice(0, voice.indexOf(":")), voice.slice(voice.indexOf(":") + 1)];
  if (kind === "stock") {
    const stock = await voiceProvider().listStockVoices();
    const match = stock.find((v) => v.ref === value);
    if (!match) throw new UserError("unknownVoice");
    if (!match.speaks.includes(language)) {
      throw new UserError("voiceNoMandarin", { name: match.name });
    }
    return { voiceRef: value, voiceId: null };
  }
  if (kind === "clone") {
    const [v] = await db
      .select()
      .from(voices)
      .where(and(eq(voices.id, value), eq(voices.userId, userId), isNull(voices.deletedAt)));
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

async function push(a: Agent, knowledge?: KnowledgeState): Promise<Agent> {
  const spec = toSpec(a, await voiceApiKeyRef(a), knowledge);
  let assistantId = a.providerAssistantId;
  if (assistantId) await voiceProvider().updateAssistant(assistantId, spec);
  else assistantId = (await voiceProvider().createAssistant(spec)).assistantId;
  const [u] = await db
    .update(agents)
    .set({ providerAssistantId: assistantId, status: "ready", failureReason: null, failureMsg: null, syncedConfig: agentFingerprint(knowledge) })
    .where(eq(agents.id, a.id))
    .returning();
  return u;
}

/**
 * Re-push an agent after its knowledge base changed (mode, bucket, deletions), or to catch up a stale
 * one. Never changes the agent's status: on failure the provider keeps the previous assistant and the
 * fingerprint stays stale, so it is retried later (SPEC §18.3). Returns whether it was pushed.
 */
export async function syncAgentQuietly(a: Agent): Promise<boolean> {
  try {
    await push(a, (await desiredKnowledge([a.id])).get(a.id));
    return true;
  } catch (err) {
    console.error("syncAgentQuietly failed", a.id, err);
    return false;
  }
}

/** Push the agent config to the provider; records failure instead of throwing. */
export async function syncAgent(a: Agent): Promise<Agent> {
  try {
    const knowledge = (await desiredKnowledge([a.id])).get(a.id);
    try {
      return await push(a, knowledge);
    } catch (err) {
      if (!knowledge) throw err;
      // A knowledge-base problem must not fail the save: push without it. The stale fingerprint
      // shows the knowledge base as not applied yet, and it is retried later.
      console.error("syncAgent with knowledge failed; retrying without", a.id, err);
      return await push(a);
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
    const [u] = await db
      .update(agents)
      .set({ status: "failed", ...reason })
      .where(eq(agents.id, a.id))
      .returning();
    return u;
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

/** Re-push agents whose provider copy is out of date. Failures leave the agent as it is, to retry later. */
export async function resyncStaleAgents(userId?: string): Promise<number> {
  const stale = await staleAgents(userId);
  for (const a of stale) await syncAgentQuietly(a);
  return stale.length;
}

export async function deleteAgent(userId: string, agentId: string): Promise<void> {
  const a = await getUserAgent(userId, agentId);
  if (!a) throw new UserError("agentNotFound");
  if (a.providerAssistantId) {
    try {
      await voiceProvider().deleteAssistant(a.providerAssistantId);
    } catch (err) {
      console.error("deleteAssistant failed", a.id, err);
    }
  }
  await db.transaction(async (tx) => {
    await tx.update(phoneNumbers).set({ agentId: null }).where(eq(phoneNumbers.agentId, a.id));
    await tx.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, a.id));
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
    if (problem === "format") throw new UserError("variableKeyInvalid", { key });
    if (problem === "reserved") throw new UserError("variableKeyReserved", { key });
    if (seen.has(key)) throw new UserError("variableKeyDuplicate", { key });
    // A value asked for on each call may be left blank there; any other needs one here.
    if (!value && !askPerCall) throw new UserError("variableValueRequired", { key });
    seen.add(key);
  }
}
