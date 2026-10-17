import type { Locale } from "@/i18n/locales";
import { MESSAGES, type Messages } from "@/i18n/messages";
import { createTranslator } from "next-intl";
import type { ErrorKey, ErrorValues, UserError } from "./errors";

/**
 * Text the server writes to the database and shows later (ledger descriptions, call outcomes,
 * failure reasons). Rows keep the English sentence, for logs and older rows, plus the message
 * it came from, so it can be shown in the viewer's language.
 */
export interface StoredMessage {
  key: `stored.${keyof Messages["stored"]}` | `errors.${ErrorKey}`;
  values?: ErrorValues;
}

/** A message we wrote, or a provider's own words (shown as-is). */
export type StoredText = StoredMessage | string;

export function stored(key: keyof Messages["stored"], values?: ErrorValues): StoredMessage {
  return { key: `stored.${key}`, values };
}

export function storedFromError(err: UserError): StoredMessage {
  return { key: `errors.${err.key}`, values: err.values };
}

/** The English text and the message, for a row's text column and its `_msg` column. */
export function storedColumns(text: StoredText): { text: string; msg: StoredMessage | null } {
  return typeof text === "string" ? { text, msg: null } : { text: render("en", text) ?? text.key, msg: text };
}

/** What to show for a stored text: the message in `locale` when there is one, else the stored English. */
export function showStored(locale: Locale, text: string, msg: StoredMessage | null | undefined): string;
export function showStored(locale: Locale, text: string | null, msg: StoredMessage | null | undefined): string | null;
export function showStored(locale: Locale, text: string | null, msg: StoredMessage | null | undefined): string | null {
  return (msg && render(locale, msg)) ?? text;
}

function render(locale: Locale, msg: StoredMessage): string | null {
  const t = createTranslator({ locale, messages: MESSAGES[locale] });
  // A key renamed or removed since the row was written falls back to the stored English.
  if (!t.has(msg.key)) return null;
  return t(msg.key, msg.values ?? {});
}
