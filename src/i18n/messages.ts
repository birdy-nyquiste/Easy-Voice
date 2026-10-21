import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ja from "@/messages/ja.json";
import vi from "@/messages/vi.json";
import zh from "@/messages/zh.json";
import { BCP47, type Locale } from "./locales";

export type Messages = typeof en;
export const MESSAGES: Record<Locale, Messages> = { en, zh, es, ja, vi };

function create<N extends keyof Messages>(locale: Locale, namespace: N) {
  // Numbers in messages (amounts in errors and stored text) format like formatCents: es-419, not Spain.
  // next-intl types `locale` as our codes, but it only hands it to Intl here.
  return createTranslator({ locale: BCP47[locale] as Locale, messages: MESSAGES[locale], namespace });
}

// Translators are reused: errors and stored text are rendered once per row on list pages.
const cache = new Map<string, unknown>();

/** A translator for code that runs outside a request render (errors, emails, stored text). */
export function translator<N extends keyof Messages>(locale: Locale, namespace: N): ReturnType<typeof create<N>> {
  const key = `${locale}:${namespace}`;
  let t = cache.get(key) as ReturnType<typeof create<N>> | undefined;
  if (!t) cache.set(key, (t = create(locale, namespace)));
  return t;
}
