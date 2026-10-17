import type { Locale } from "@/i18n/locales";
import { translator, type Messages } from "@/i18n/messages";
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

/** The failure columns (agents, voices, numbers, payments): English text plus the message. */
export function failureColumns(reason: StoredText) {
  const r = storedColumns(reason);
  return { failureReason: r.text, failureMsg: r.msg };
}

/** A call's outcome columns: English text plus the message. */
export function outcomeColumns(outcome: StoredText) {
  const o = storedColumns(outcome);
  return { outcome: o.text, outcomeMsg: o.msg };
}

/** What to show for a stored text: the message in `locale` when there is one, else the stored English. */
export function showStored(locale: Locale, text: string, msg: StoredMessage | null | undefined): string;
export function showStored(locale: Locale, text: string | null, msg: StoredMessage | null | undefined): string | null;
export function showStored(locale: Locale, text: string | null, msg: StoredMessage | null | undefined): string | null {
  return (msg && render(locale, msg)) ?? text;
}

function render(locale: Locale, msg: StoredMessage): string | null {
  const [namespace, key] = msg.key.split(".") as ["stored" | "errors", string];
  // Keys come from the database, so they're checked at runtime rather than by the compiler.
  const t = translator(locale, namespace) as unknown as { (key: string, values: ErrorValues): string; has(key: string): boolean };
  // A key renamed or removed since the row was written falls back to the stored English.
  if (!t.has(key)) return null;
  return t(key, msg.values ?? {});
}
