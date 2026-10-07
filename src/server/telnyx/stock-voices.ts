import type { StockVoice } from "./types";

/**
 * Curated built-in voices offered to users. The catalog endpoint doesn't say how to
 * build the assistant voice string, so we pin known-good refs here (SPEC §11.2: verify
 * each against a live account before launch).
 */
export const STOCK_VOICES: StockVoice[] = [
  { ref: "Telnyx.KokoroTTS.af_heart", name: "Heart", language: "en-US", gender: "female", provider: "Telnyx" },
  { ref: "Telnyx.KokoroTTS.am_adam", name: "Adam", language: "en-US", gender: "male", provider: "Telnyx" },
  { ref: "Telnyx.NaturalHD.astra", name: "Astra", language: "en-US", gender: "female", provider: "Telnyx" },
  { ref: "Telnyx.KokoroTTS.zf_xiaobei", name: "Xiaobei", language: "zh-CN", gender: "female", provider: "Telnyx" },
  { ref: "Telnyx.KokoroTTS.zm_yunjian", name: "Yunjian", language: "zh-CN", gender: "male", provider: "Telnyx" },
];
