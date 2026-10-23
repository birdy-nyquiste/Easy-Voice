import { getRequestConfig } from "next-intl/server";
import { headers } from "next/headers";
import { getCurrentUser } from "@/server/auth";
import { cookieLocale } from "@/server/locale";
import { viewerTimeZone } from "@/server/time-zone";
import { localeFromAcceptLanguage, parseLocale, type Locale } from "./locales";
import { MESSAGES } from "./messages";

/**
 * The interface language: the one picked in this browser (ev_locale cookie), else the signed-in
 * user's saved choice, else the browser's languages. URLs carry no locale.
 */
export async function requestLocale(): Promise<Locale> {
  return (
    (await cookieLocale()) ??
    // Checked, not trusted: a build that knows more languages (a preview on the shared database, or
    // before a rollback) may have saved one this build doesn't have.
    parseLocale((await getCurrentUser())?.locale) ??
    localeFromAcceptLanguage((await headers()).get("accept-language"))
  );
}

export default getRequestConfig(async () => {
  const locale = await requestLocale();
  return { locale, messages: MESSAGES[locale], timeZone: (await viewerTimeZone()) ?? "UTC" };
});
