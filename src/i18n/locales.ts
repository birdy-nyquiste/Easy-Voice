/** Interface languages. Separate from an agent's call language (src/lib/language.ts). */
export const LOCALES = ["en", "zh", "es", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** For <html lang> and Intl formatting. Chinese is Simplified only; Spanish is Latin American. */
export const BCP47: Record<Locale, string> = { en: "en-US", zh: "zh-CN", es: "es-419", ja: "ja-JP" };

export function parseLocale(v: unknown): Locale | null {
  return LOCALES.find((l) => l === v) ?? null;
}

/** Best interface language for an Accept-Language header, e.g. "zh-CN,zh;q=0.9,en;q=0.8" → "zh". */
export function localeFromAcceptLanguage(header: string | null): Locale {
  const ranked = (header ?? "")
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { tag: tag.toLowerCase(), q: q === undefined ? 1 : Number(q) || 0 };
    })
    .filter((r) => r.tag && r.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    // Traditional Chinese readers get English rather than Simplified.
    if (tag === "zh" || tag.startsWith("zh-cn") || tag.startsWith("zh-sg") || tag.startsWith("zh-hans")) return "zh";
    if (tag === "es" || tag.startsWith("es-")) return "es";
    if (tag === "ja" || tag.startsWith("ja-")) return "ja";
    if (tag.startsWith("en")) return "en";
  }
  return DEFAULT_LOCALE;
}
