import "server-only";
import { createHash } from "node:crypto";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db, withUserLock } from "@/db";
import { agents, elevenLabsKeys, phoneNumbers, voices, type Agent } from "@/db/schema";
import { config } from "@/lib/config";
import { UserError, type ErrorKey } from "@/lib/errors";
import { stored, storedColumns, storedFromError } from "@/lib/stored-text";
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

const INPUT_ERRORS = { nameRequired: 1, instructionsRequired: 1, greetingRequired: 1, voiceRequired: 1 } satisfies Partial<Record<ErrorKey, 1>>;

export const agentInput = z.object({
  name: z.string().trim().min(1, "nameRequired").max(80),
  instructions: z.string().trim().min(1, "instructionsRequired").max(8000),
  greeting: z.string().trim().min(1, "greetingRequired").max(500),
  language: z.enum(LANGUAGES),
  /** "stock:<ref>" or "clone:<voice uuid>" */
  voice: z.string().min(1, "voiceRequired"),
  /** LLM id from listModels(); empty means the platform default. */
  model: z.string().trim().optional().transform((m) => m || null),
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

function toSpec(
  a: Pick<Agent, "name" | "instructions" | "greeting" | "language" | "voiceRef" | "model">,
  voiceApiKeyRef?: string,
): AssistantSpec {
  const englishOnly = !voiceSpeaks(a.voiceRef).includes("zh");
  return {
    name: a.name,
    instructions: englishOnly ? `${a.instructions}\n\n${ENGLISH_ONLY_VOICE_RULE}` : a.instructions,
    greeting: providerGreeting(a.language, a.greeting),
    language: a.language,
    voiceRef: a.voiceRef,
    voiceApiKeyRef,
    model: a.model ?? config.telnyx.llmModel,
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

/** Push the agent config to the provider; records failure instead of throwing. */
export async function syncAgent(a: Agent): Promise<Agent> {
  try {
    const spec = toSpec(a, await voiceApiKeyRef(a));
    let assistantId = a.providerAssistantId;
    if (assistantId) await voiceProvider().updateAssistant(assistantId, spec);
    else assistantId = (await voiceProvider().createAssistant(spec)).assistantId;
    const [u] = await db
      .update(agents)
      .set({ providerAssistantId: assistantId, status: "ready", failureReason: null, failureMsg: null, syncedConfig: platformFingerprint() })
      .where(eq(agents.id, a.id))
      .returning();
    return u;
  } catch (err) {
    console.error("syncAgent failed", a.id, err);
    const reason = storedColumns(
      err instanceof FeatureNotPermittedError && err.feature === "cloned_voices"
        ? storedFromError(new UserError("cloningUnavailablePickBuiltIn"))
        : err instanceof UserError
          ? storedFromError(err)
          : stored("agentSaveFailed"),
    );
    const [u] = await db
      .update(agents)
      .set({ status: "failed", failureReason: reason.text, failureMsg: reason.msg })
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

/** Re-push agents whose provider copy predates the current platform settings. */
export async function resyncStaleAgents(userId?: string): Promise<number> {
  const fp = platformFingerprint();
  const stale = await db
    .select()
    .from(agents)
    .where(
      and(
        isNull(agents.deletedAt),
        eq(agents.status, "ready"),
        or(isNull(agents.syncedConfig), ne(agents.syncedConfig, fp)),
        userId ? eq(agents.userId, userId) : undefined,
      ),
    );
  for (const a of stale) await syncAgent(a);
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
  await db.update(phoneNumbers).set({ agentId: null }).where(eq(phoneNumbers.agentId, a.id));
  await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, a.id));
}

function parse(raw: unknown): AgentInput {
  const r = agentInput.safeParse(raw);
  if (r.success) return r.data;
  // Our own messages (above) are error keys; anything else zod reports gets a generic one.
  const message = r.error.issues[0]?.message;
  throw new UserError(message && message in INPUT_ERRORS ? (message as ErrorKey) : "invalidInput");
}
