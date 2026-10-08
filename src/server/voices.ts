import "server-only";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db, withUserLock } from "@/db";
import { agents, voices, type Voice } from "@/db/schema";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { formatCents, formatMegabytes } from "@/lib/format";
import { chargePurchase, refundPurchase, type Purchase } from "./billing/ledger";
import type { Language } from "@/lib/language";
import { voiceProvider, type PreviewAudio, type StockVoice } from "./telnyx";

export async function listStockVoices(language?: Language): Promise<StockVoice[]> {
  const all = await voiceProvider().listStockVoices();
  if (!language) return all;
  return all.filter((v) => v.language.toLowerCase().startsWith(language));
}

/** What built-in voices say when previewed; bilingual voices show off both languages. */
export const PREVIEW_TEXT = {
  en: "Hi, thanks for calling. I'm your assistant. How can I help you today?",
  bilingual: "您好，感谢您的来电，我是您的语音助理。Hi, I can speak English too. How can I help?",
} as const;

// Previews are fixed per voice, so keep them per process instead of paying for TTS on every click.
const PREVIEW_CACHE_MAX = 100;
const previewCache = new Map<string, PreviewAudio>();

/** Audio for a voice picker value ("stock:<ref>" or "clone:<voice uuid>"); null if not found. */
export async function voicePreview(userId: string, voice: string): Promise<PreviewAudio | null> {
  const [kind, value] = [voice.slice(0, voice.indexOf(":")), voice.slice(voice.indexOf(":") + 1)];
  let key: string;
  let load: () => Promise<PreviewAudio>;
  if (kind === "stock") {
    // Only catalog voices we offer, so this can't be used to run arbitrary (paid) providers.
    const match = (await listStockVoices()).find((v) => v.ref === value);
    if (!match) return null;
    key = voice;
    load = () => voiceProvider().synthesizePreview(match.ref, match.speaks.includes("zh") ? PREVIEW_TEXT.bilingual : PREVIEW_TEXT.en);
  } else if (kind === "clone") {
    const [v] = await db
      .select()
      .from(voices)
      .where(and(eq(voices.id, value), eq(voices.userId, userId), isNull(voices.deletedAt)));
    if (!v?.providerVoiceId) return null;
    key = `clone:${v.providerVoiceId}`;
    const providerVoiceId = v.providerVoiceId;
    load = () => voiceProvider().getCloneSample(providerVoiceId);
  } else {
    return null;
  }
  const hit = previewCache.get(key);
  if (hit) return hit;
  const audio = await load();
  if (previewCache.size >= PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value!);
  previewCache.set(key, audio);
  return audio;
}

export async function listUserVoices(userId: string): Promise<Voice[]> {
  return db.select().from(voices).where(and(eq(voices.userId, userId), isNull(voices.deletedAt)));
}

export async function cloneVoice(
  userId: string,
  input: { name: string; language: Language; gender: "male" | "female"; audio: File; consent: boolean },
): Promise<Voice> {
  const name = input.name.trim();
  if (!name) throw new UserError("Give the voice a name.");
  if (!input.consent) throw new UserError("You must confirm this is your voice or that you have the speaker's consent.");
  if (!input.audio || input.audio.size === 0) throw new UserError("Upload or record an audio sample.");
  const maxBytes = Math.min(voiceProvider().maxCloneSampleBytes, config.limits.cloneSampleBytes);
  if (input.audio.size > maxBytes) throw new UserError(`Audio sample must be under ${formatMegabytes(maxBytes)}.`);

  const row = await withUserLock(userId, async (tx) => {
    const existing = await tx
      .select({ id: voices.id })
      .from(voices)
      .where(and(eq(voices.userId, userId), isNull(voices.deletedAt), ne(voices.status, "failed")));
    if (existing.length >= config.limits.clonedVoicesPerUser) {
      throw new UserError(`You can have up to ${config.limits.clonedVoicesPerUser} cloned voices.`);
    }
    const [inserted] = await tx
      .insert(voices)
      .values({ userId, name, language: input.language, consentAt: new Date(), status: "processing" })
      .returning();
    await chargePurchase(
      clonePurchase(inserted),
      `Insufficient balance. A voice clone costs ${formatCents(config.pricing.voiceCloneCents)} — top up first.`,
      tx,
    );
    return inserted;
  });

  try {
    const res = await voiceProvider().cloneVoice({ name, language: input.language, gender: input.gender, audio: input.audio });
    if (res.status === "failed") return failVoice(row, res.failureReason ?? "The sample couldn't be used. Try a clearer recording.");
    const [u] = await db
      .update(voices)
      .set({ providerVoiceId: res.voiceId, voiceRef: res.ref, status: res.status })
      .where(eq(voices.id, row.id))
      .returning();
    return u;
  } catch (err) {
    console.error("cloneVoice failed", err);
    return failVoice(row, "The voice could not be cloned. Try a clearer, longer sample.");
  }
}

function clonePurchase(v: Pick<Voice, "id" | "userId" | "name">): Purchase {
  return {
    userId: v.userId,
    priceCents: config.pricing.voiceCloneCents,
    kind: "voice_clone",
    key: `voice:${v.id}`,
    description: `Voice clone "${v.name}"`,
    refType: "voice",
    refId: v.id,
  };
}

async function failVoice(v: Voice, reason: string): Promise<Voice> {
  await refundPurchase(clonePurchase(v), `Refund — voice clone "${v.name}" failed`);
  const [u] = await db.update(voices).set({ status: "failed", failureReason: reason }).where(eq(voices.id, v.id)).returning();
  return u;
}

/** Move processing clones to ready/failed. */
export async function refreshProcessingVoices(userId: string): Promise<void> {
  const rows = await db
    .select()
    .from(voices)
    .where(and(eq(voices.userId, userId), eq(voices.status, "processing"), isNull(voices.deletedAt)));
  for (const v of rows) {
    if (!v.providerVoiceId) continue;
    try {
      const res = await voiceProvider().getClonedVoice(v.providerVoiceId);
      if (res.status === "ready") await db.update(voices).set({ status: "ready", voiceRef: res.ref || v.voiceRef }).where(eq(voices.id, v.id));
      else if (res.status === "failed") await failVoice(v, res.failureReason ?? "Cloning failed.");
    } catch (err) {
      console.error("getClonedVoice failed", v.id, err);
    }
  }
}

export async function deleteVoice(userId: string, voiceId: string): Promise<void> {
  const [v] = await db.select().from(voices).where(and(eq(voices.id, voiceId), eq(voices.userId, userId)));
  if (!v || v.deletedAt) throw new UserError("Voice not found.");
  const using = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.voiceId, v.id), isNull(agents.deletedAt)));
  if (using.length) throw new UserError("This voice is used by an agent. Change the agent's voice first.");
  if (v.providerVoiceId) {
    try {
      await voiceProvider().deleteClonedVoice(v.providerVoiceId);
    } catch (err) {
      console.error("deleteClonedVoice failed", v.id, err);
    }
  }
  await db.update(voices).set({ deletedAt: new Date() }).where(eq(voices.id, v.id));
}
