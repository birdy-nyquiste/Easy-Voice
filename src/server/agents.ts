import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, phoneNumbers, voices, type Agent } from "@/db/schema";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { voiceProvider, type AssistantSpec } from "./telnyx";

export const RECORDING_NOTICE = {
  en: "This call may be recorded.",
  zh: "本次通话可能会被录音。",
} as const;

export const agentInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  instructions: z.string().trim().min(1, "Instructions are required").max(8000),
  greeting: z.string().trim().min(1, "Greeting is required").max(500),
  language: z.enum(["en", "zh"]),
  /** "stock:<ref>" or "clone:<voice uuid>" */
  voice: z.string().min(1, "Pick a voice"),
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

async function resolveVoice(userId: string, voice: string): Promise<{ voiceRef: string; voiceId: string | null }> {
  const [kind, value] = [voice.slice(0, voice.indexOf(":")), voice.slice(voice.indexOf(":") + 1)];
  if (kind === "stock") {
    const stock = await voiceProvider().listStockVoices();
    if (!stock.some((v) => v.ref === value)) throw new UserError("Unknown voice.");
    return { voiceRef: value, voiceId: null };
  }
  if (kind === "clone") {
    const [v] = await db
      .select()
      .from(voices)
      .where(and(eq(voices.id, value), eq(voices.userId, userId), isNull(voices.deletedAt)));
    if (!v) throw new UserError("Unknown voice.");
    if (v.status !== "ready" || !v.voiceRef) throw new UserError("That cloned voice isn't ready yet.");
    return { voiceRef: v.voiceRef, voiceId: v.id };
  }
  throw new UserError("Unknown voice.");
}

/** The greeting sent to the provider always starts with the recording notice (SPEC §16). */
export function providerGreeting(language: "en" | "zh", greeting: string): string {
  const notice = RECORDING_NOTICE[language];
  return greeting.includes(notice) ? greeting : `${notice} ${greeting}`;
}

function toSpec(a: Pick<Agent, "name" | "instructions" | "greeting" | "language" | "voiceRef">): AssistantSpec {
  const language = a.language as "en" | "zh";
  return {
    name: a.name,
    instructions: a.instructions,
    greeting: providerGreeting(language, a.greeting),
    language,
    voiceRef: a.voiceRef,
  };
}

export async function createAgent(userId: string, raw: unknown): Promise<Agent> {
  const input = parse(raw);
  const count = (await listUserAgents(userId)).length;
  if (count >= config.limits.agentsPerUser) throw new UserError(`You can have up to ${config.limits.agentsPerUser} agents.`);
  const voice = await resolveVoice(userId, input.voice);
  const [row] = await db
    .insert(agents)
    .values({ userId, ...input, ...voice, status: "syncing" })
    .returning();
  return syncAgent(row);
}

export async function updateAgent(userId: string, agentId: string, raw: unknown): Promise<Agent> {
  const existing = await getUserAgent(userId, agentId);
  if (!existing) throw new UserError("Agent not found.");
  const input = parse(raw);
  const voice = await resolveVoice(userId, input.voice);
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
    let assistantId = a.providerAssistantId;
    if (assistantId) await voiceProvider().updateAssistant(assistantId, toSpec(a));
    else assistantId = (await voiceProvider().createAssistant(toSpec(a))).assistantId;
    const [u] = await db
      .update(agents)
      .set({ providerAssistantId: assistantId, status: "ready", failureReason: null })
      .where(eq(agents.id, a.id))
      .returning();
    return u;
  } catch (err) {
    console.error("syncAgent failed", a.id, err);
    const [u] = await db
      .update(agents)
      .set({ status: "failed", failureReason: "Couldn't save the agent to the voice platform. Try saving again." })
      .where(eq(agents.id, a.id))
      .returning();
    return u;
  }
}

export async function deleteAgent(userId: string, agentId: string): Promise<void> {
  const a = await getUserAgent(userId, agentId);
  if (!a) throw new UserError("Agent not found.");
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
  if (!r.success) throw new UserError(r.error.issues[0]?.message ?? "Invalid input");
  return r.data;
}
