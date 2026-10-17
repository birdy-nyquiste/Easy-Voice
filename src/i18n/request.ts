import { getRequestConfig } from "next-intl/server";
import { headers } from "next/headers";
import { getCurrentUser } from "@/server/auth";
import { cookieLocale } from "@/server/locale";
import { localeFromAcceptLanguage, type Locale } from "./locales";
import { MESSAGES } from "./messages";

/**
 * The interface language: the one picked in this browser (ev_locale cookie), else the signed-in
 * user's saved choice, else the browser's languages. URLs carry no locale.
 */
export async function requestLocale(): Promise<Locale> {
  return (
    (await cookieLocale()) ??
    (await getCurrentUser())?.locale ??
    localeFromAcceptLanguage((await headers()).get("accept-language"))
  );
}

export default getRequestConfig(async () => {
  const locale = await requestLocale();
  return { locale, messages: MESSAGES[locale] };
});
