import "server-only";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db";
import { users, type User } from "@/db/schema";
import { parseLocale, type Locale } from "@/i18n/locales";
import { LOCALE_COOKIE } from "@/lib/ui-prefs";

/** The language this browser picked with the switcher, if any (we never set the cookie otherwise). */
export async function cookieLocale(): Promise<Locale | null> {
  return parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
}

export async function setLocaleCookie(locale: Locale): Promise<void> {
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
}

/** Remember the user's language for their other devices. */
export async function saveUserLocale(user: User, locale: Locale): Promise<void> {
  if (user.locale !== locale) await db.update(users).set({ locale }).where(eq(users.id, user.id));
}

/**
 * At sign-in, carry the language over between this browser and the account: one picked in this
 * browser (e.g. on the login page) wins and is saved; otherwise the saved choice is restored here.
 */
export async function syncLocaleAtSignIn(user: User): Promise<void> {
  const picked = await cookieLocale();
  if (picked) await saveUserLocale(user, picked);
  else if (user.locale) await setLocaleCookie(user.locale);
}
