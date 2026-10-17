import type { Locale } from "@/i18n/locales";
import { translator, type Messages } from "@/i18n/messages";

export type ErrorKey = keyof Messages["errors"];
export type ErrorValues = Record<string, string | number>;

/**
 * An error meant to be shown to the user. It carries a message key (in the "errors" section of
 * src/messages) so it can be shown in the user's language; `message` is the English text, for logs.
 */
export class UserError extends Error {
  constructor(
    readonly key: ErrorKey,
    readonly values: ErrorValues = {},
  ) {
    super(errorText("en", key, values));
    this.name = "UserError";
  }
}

export function errorText(locale: Locale, key: ErrorKey, values: ErrorValues = {}): string {
  return translator(locale, "errors")(key, values);
}

export function userMessage(err: unknown, locale: Locale, fallback: ErrorKey = "generic"): string {
  return err instanceof UserError ? errorText(locale, err.key, err.values) : errorText(locale, fallback);
}
