import "server-only";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db, withUserLock } from "@/db";
import { agents, voices, type Voice } from "@/db/schema";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { formatCents } from "@/lib/format";
import { chargePurchase, refundPurchase, type Purchase } from "./billing/ledger";
import type { Language } from "@/lib/language";
import { voiceProvider, type StockVoice } from "./telnyx";

export async function listStockVoices(language?: Language): Promise<StockVoice[]> {
  const all = await voiceProvider().listStockVoices();
  if (!language) return all;
  return all.filter((v) => v.language.toLowerCase().startsWith(language));
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
  const maxBytes = voiceProvider().maxCloneSampleBytes;
  if (input.audio.size > maxBytes) throw new UserError(`Audio sample must be under ${Math.floor(maxBytes / 1024 / 1024)} MB.`);

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
    if (res.status === "failed") return failVoice(row, res.failureReason ?? "The provider rejected the sample.");
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
