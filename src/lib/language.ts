export const LANGUAGES = ["en", "zh"] as const;
export type Language = (typeof LANGUAGES)[number];

export function toLanguage(v: unknown): Language {
  return v === "zh" ? "zh" : "en";
}
