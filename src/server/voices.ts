import "server-only";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db, withUserLock, type Tx } from "@/db";
import { agents, voices, type Voice } from "@/db/schema";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { failureColumns, stored, storedFromError, type StoredText } from "@/lib/stored-text";
import { toMegabytes } from "@/lib/format";
import { isUuid } from "@/lib/uuid";
import { chargePurchase, refundPurchase, type Purchase } from "./billing/ledger";
import { elevenLabs } from "./elevenlabs";
import {
  elevenLabsUserError,
  getElevenLabsKey,
  isKeyRejection,
  recordKeyStatus,
  requireElevenLabsApiKey,
} from "./elevenlabs-keys";
import { decryptSecret } from "./secrets";
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
  } else if (kind === "clone" && isUuid(value)) {
    const [v] = await db
      .select()
      .from(voices)
      .where(and(eq(voices.id, value), eq(voices.userId, userId), isNull(voices.deletedAt)));
    if (!v?.providerVoiceId) return null;
    key = `clone:${v.providerVoiceId}`;
    const providerVoiceId = v.providerVoiceId;
    if (v.provider === "elevenlabs") {
      // ElevenLabs keeps no sample we can fetch, so speak a line (on the user's own credits).
      const keyRow = await getElevenLabsKey(userId);
      if (!keyRow) return null;
      const apiKey = decryptSecret(keyRow.keyEncrypted);
      load = () =>
        elevenLabs()
          .synthesize(apiKey, providerVoiceId, PREVIEW_TEXT.bilingual)
          .catch(async (err) => {
            if (isKeyRejection(err)) await recordKeyStatus(userId, true);
            throw err;
          });
    } else {
      load = () => voiceProvider().getCloneSample(providerVoiceId);
    }
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

export type CloneProvider = Voice["provider"];

/** Whether new clones can be made with (and agents can use voices from) this provider. */
export function cloningAvailable(provider: CloneProvider): boolean {
  return provider === "elevenlabs" ? config.features.elevenLabs : config.features.voiceCloning;
}

/**
 * Telnyx clones are made on our account and charged; ElevenLabs clones are made in the user's
 * own account with their key, so they cost nothing here (docs/elevenlabs-notes.md §5).
 */
export async function cloneVoice(
  userId: string,
  input: { name: string; language: Language; gender: "male" | "female"; audio: File; consent: boolean; provider?: CloneProvider },
): Promise<Voice> {
  const provider = input.provider ?? "telnyx";
  if (!cloningAvailable(provider)) throw new UserError(provider === "elevenlabs" ? "elevenLabsUnavailable" : "cloningUnavailable");
  const name = input.name.trim();
  if (!name) throw new UserError("voiceNameRequired");
  if (!input.consent) throw new UserError("consentRequired");
  if (!input.audio || input.audio.size === 0) throw new UserError("audioRequired");
  const providerMax = provider === "elevenlabs" ? elevenLabs().maxCloneSampleBytes : voiceProvider().maxCloneSampleBytes;
  const maxBytes = Math.min(providerMax, config.limits.cloneSampleBytes);
  if (input.audio.size > maxBytes) throw new UserError("audioTooLarge", { size: toMegabytes(maxBytes) });
  if (provider === "elevenlabs") return cloneWithElevenLabs(userId, { ...input, name });

  const row = await withUserLock(userId, async (tx) => {
    await checkCloneLimit(tx, userId, "telnyx");
    const [inserted] = await tx
      .insert(voices)
      .values({ userId, name, language: input.language, consentAt: new Date(), status: "processing" })
      .returning();
    await chargePurchase(
      clonePurchase(inserted),
      new UserError("cloneInsufficientBalance", { price: config.pricing.voiceCloneCents / 100 }),
      tx,
    );
    return inserted;
  });

  try {
    const res = await voiceProvider().cloneVoice({ name, language: input.language, gender: input.gender, audio: input.audio });
    if (res.status === "failed") return failVoice(row, res.failureReason ?? stored("voiceSampleUnusable"));
    const [u] = await db
      .update(voices)
      .set({ providerVoiceId: res.voiceId, voiceRef: res.ref, status: res.status })
      .where(eq(voices.id, row.id))
      .returning();
    return u;
  } catch (err) {
    console.error("cloneVoice failed", err);
    return failVoice(row, stored("voiceCloneFailed"));
  }
}

async function checkCloneLimit(tx: Tx, userId: string, provider: CloneProvider) {
  const existing = await tx
    .select({ id: voices.id })
    .from(voices)
    .where(and(eq(voices.userId, userId), eq(voices.provider, provider), isNull(voices.deletedAt), ne(voices.status, "failed")));
  if (existing.length >= config.limits.clonedVoicesPerUser) {
    throw new UserError(provider === "elevenlabs" ? "cloneLimitElevenLabs" : "cloneLimit", { max: config.limits.clonedVoicesPerUser });
  }
}

async function cloneWithElevenLabs(
  userId: string,
  input: { name: string; language: Language; gender: "male" | "female"; audio: File },
): Promise<Voice> {
  const apiKey = await requireElevenLabsApiKey(userId);
  const row = await withUserLock(userId, async (tx) => {
    await checkCloneLimit(tx, userId, "elevenlabs");
    const [inserted] = await tx
      .insert(voices)
      .values({ userId, name: input.name, language: input.language, provider: "elevenlabs", consentAt: new Date(), status: "processing" })
      .returning();
    return inserted;
  });

  let voiceId: string;
  try {
    const res = await elevenLabs().cloneVoice(apiKey, input);
    voiceId = res.voiceId;
    if (res.requiresVerification) {
      // Not usable on calls until verified in ElevenLabs; don't leave it taking up a slot there.
      await elevenLabs().deleteVoice(apiKey, voiceId).catch((err) => console.error("ElevenLabs deleteVoice failed", err));
      return failVoice(row, stored("voiceNeedsVerification"));
    }
  } catch (err) {
    console.error("ElevenLabs cloneVoice failed", err);
    if (isKeyRejection(err)) await recordKeyStatus(userId, true);
    const userErr = elevenLabsUserError(err, "clone");
    return failVoice(row, userErr instanceof UserError ? storedFromError(userErr) : stored("voiceElevenLabsFailed"));
  }
  const [u] = await db
    .update(voices)
    .set({ providerVoiceId: voiceId, voiceRef: `ElevenLabs.${config.elevenlabs.ttsModel}.${voiceId}`, status: "ready" })
    .where(eq(voices.id, row.id))
    .returning();
  return u;
}

function clonePurchase(v: Pick<Voice, "id" | "userId" | "name">): Purchase {
  return {
    userId: v.userId,
    priceCents: config.pricing.voiceCloneCents,
    kind: "voice_clone",
    key: `voice:${v.id}`,
    description: stored("ledgerVoiceClone", { name: v.name }),
    refType: "voice",
    refId: v.id,
  };
}

async function failVoice(v: Voice, reason: StoredText): Promise<Voice> {
  if (v.provider === "telnyx") await refundPurchase(clonePurchase(v), stored("ledgerVoiceCloneRefund", { name: v.name }));
  const [u] = await db
    .update(voices)
    .set({ status: "failed", ...failureColumns(reason) })
    .where(eq(voices.id, v.id))
    .returning();
  return u;
}

/** Move processing clones to ready/failed. */
export async function refreshProcessingVoices(userId: string): Promise<void> {
  const rows = await db
    .select()
    .from(voices)
    .where(and(eq(voices.userId, userId), eq(voices.provider, "telnyx"), eq(voices.status, "processing"), isNull(voices.deletedAt)));
  for (const v of rows) {
    if (!v.providerVoiceId) continue;
    try {
      const res = await voiceProvider().getClonedVoice(v.providerVoiceId);
      if (res.status === "ready") await db.update(voices).set({ status: "ready", voiceRef: res.ref || v.voiceRef }).where(eq(voices.id, v.id));
      else if (res.status === "failed") await failVoice(v, res.failureReason ?? stored("voiceCloningFailed"));
    } catch (err) {
      console.error("getClonedVoice failed", v.id, err);
    }
  }
}

export async function deleteVoice(userId: string, voiceId: string): Promise<void> {
  const [v] = await db.select().from(voices).where(and(eq(voices.id, voiceId), eq(voices.userId, userId)));
  if (!v || v.deletedAt) throw new UserError("voiceNotFound");
  const using = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.voiceId, v.id), isNull(agents.deletedAt)));
  if (using.length) throw new UserError("voiceInUse");
  if (v.providerVoiceId) {
    try {
      if (v.provider === "elevenlabs") {
        // It lives in the user's ElevenLabs account; deleting it there frees their voice slot.
        const keyRow = await getElevenLabsKey(userId);
        if (keyRow) await elevenLabs().deleteVoice(decryptSecret(keyRow.keyEncrypted), v.providerVoiceId);
      } else {
        await voiceProvider().deleteClonedVoice(v.providerVoiceId);
      }
    } catch (err) {
      console.error("deleteClonedVoice failed", v.id, err);
    }
  }
  await db.update(voices).set({ deletedAt: new Date() }).where(eq(voices.id, v.id));
}
