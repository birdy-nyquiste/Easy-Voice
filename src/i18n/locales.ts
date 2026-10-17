import { LANGUAGES, type Language } from "@/lib/language";

/** Interface languages. The same codes as an agent's call language, but chosen separately. */
export const LOCALES = LANGUAGES;
export type Locale = Language;
export const DEFAULT_LOCALE: Locale = "en";

/** For <html lang> and Intl formatting. Chinese is Simplified only. */
export const BCP47: Record<Locale, string> = { en: "en-US", zh: "zh-CN" };

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
    if (tag.startsWith("en")) return "en";
  }
  return DEFAULT_LOCALE;
}
