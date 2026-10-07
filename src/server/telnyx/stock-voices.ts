import type { StockVoice } from "./types";

/**
 * Which Telnyx catalog voices we offer, per language. Mandarin is only available
 * on the Ultra model; Kokoro covers English well and is inexpensive.
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
      gender: v.gender?.toLowerCase(),
      provider: "Telnyx",
    }))
    .sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
}

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
