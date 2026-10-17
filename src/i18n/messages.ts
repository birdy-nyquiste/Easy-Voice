import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import zh from "@/messages/zh.json";
import type { Locale } from "./locales";

export type Messages = typeof en;
export const MESSAGES: Record<Locale, Messages> = { en, zh };

/** A translator for code that runs outside a request render (errors, emails). */
export function translator<N extends keyof Messages>(locale: Locale, namespace: N) {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace });
}
