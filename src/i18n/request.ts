import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE } from "@/lib/ui-prefs";
import { localeFromAcceptLanguage, parseLocale, type Locale } from "./locales";
import { MESSAGES } from "./messages";

/**
 * The interface language: the ev_locale cookie (set by the switcher, and at sign-in from the
 * user's saved choice), else the browser's languages. URLs carry no locale.
 */
export async function requestLocale(): Promise<Locale> {
  const fromCookie = parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return fromCookie ?? localeFromAcceptLanguage((await headers()).get("accept-language"));
}

export default getRequestConfig(async () => {
  const locale = await requestLocale();
  return { locale, messages: MESSAGES[locale] };
});
