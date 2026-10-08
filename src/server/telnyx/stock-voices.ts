import type { Language } from "@/lib/language";
import type { StockVoice } from "./types";

/**
 * Which Telnyx catalog voices we offer, per language. Mandarin is only available
 * on the Ultra model; Kokoro covers English well and is inexpensive.
 *
 * Listening test (2026-10-08) on a mixed sentence: Ultra Mandarin voices speak both
 * Mandarin and English naturally; Kokoro voices can't pronounce Chinese at all.
 */
export const OFFERED_VOICE_MODELS: Record<string, string[]> = {
  "en-US": ["KokoroTTS"],
  zh: ["Ultra"],
};

export interface CatalogVoice {
  id: string;
  name: string;
  language: string;
  model_id: string;
  gender?: string;
  deprecated?: boolean;
}

/** Filter the Telnyx catalog to the voices we offer. `id` is already the assistant voice string. */
export function toStockVoices(catalog: CatalogVoice[]): StockVoice[] {
  return catalog
    .filter((v) => !v.deprecated && OFFERED_VOICE_MODELS[v.language]?.includes(v.model_id))
    .map((v) => ({
      ref: v.id,
      name: displayName(v),
      language: v.language === "zh" ? "zh-CN" : v.language,
      speaks: voiceSpeaks(v.id),
      gender: v.gender?.toLowerCase(),
      provider: "Telnyx",
    }))
    // Bilingual voices first: they work for every agent.
    .sort((a, b) => b.speaks.length - a.speaks.length || a.name.localeCompare(b.name));
}

/** Languages a voice can pronounce, from its "Provider.Model.id" ref. */
export function voiceSpeaks(ref: string): Language[] {
  return ref.startsWith("Telnyx.KokoroTTS.") ? ["en"] : ["zh", "en"];
}

const TTS_MODEL_NAMES: Record<string, string> = { KokoroTTS: "Kokoro", Ultra: "Ultra", Qwen3TTS: "Qwen3-TTS" };

/** Display name of the speech model behind a "Provider.Model.id" voice ref. */
export function ttsModelName(ref: string): string {
  const model = ref.split(".")[1] ?? "";
  return TTS_MODEL_NAMES[model] ?? model;
}

/** Default voice for new agents: bilingual, chosen in the listening test. */
export const DEFAULT_VOICE_REF = "Telnyx.Ultra.7a5d4663-88ae-47b7-808e-8f9b9ee4127b"; // Hua - Sunny Support

/** Kokoro names look like "af_heart"; Ultra names are already human ("Hao - Friendly Guy"). */
function displayName(v: CatalogVoice): string {
  const kokoro = /^[a-z]{2}_(.+)$/.exec(v.name);
  if (v.model_id === "KokoroTTS" && kokoro) return kokoro[1].charAt(0).toUpperCase() + kokoro[1].slice(1);
  return v.name;
}

/** Mock catalog: real Telnyx entries (verified 2026-10-07) so mock data matches live. */
export const MOCK_CATALOG: CatalogVoice[] = [
  { id: "Telnyx.KokoroTTS.af_heart", name: "af_heart", language: "en-US", model_id: "KokoroTTS", gender: "Female" },
  { id: "Telnyx.KokoroTTS.am_adam", name: "am_adam", language: "en-US", model_id: "KokoroTTS", gender: "Male" },
  { id: "Telnyx.Ultra.7a5d4663-88ae-47b7-808e-8f9b9ee4127b", name: "Hua - Sunny Support", language: "zh", model_id: "Ultra", gender: "Female" },
  { id: "Telnyx.Ultra.16212f18-4955-4be9-a6cd-2196ce2c11d1", name: "Hao - Friendly Guy", language: "zh", model_id: "Ultra", gender: "Male" },
];
