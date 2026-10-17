import "server-only";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db";
import { users, type User } from "@/db/schema";
import { parseLocale, type Locale } from "@/i18n/locales";
import { LOCALE_COOKIE } from "@/lib/ui-prefs";

export async function setLocaleCookie(locale: Locale): Promise<void> {
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
}

/**
 * At sign-in, carry the language over between this browser and the account: a saved choice wins
 * (so a new device opens in it); otherwise the language picked on the login page is saved.
 */
export async function syncLocaleAtSignIn(user: User): Promise<void> {
  if (user.locale) return setLocaleCookie(user.locale);
  const picked = parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  if (picked) await db.update(users).set({ locale: picked }).where(eq(users.id, user.id));
}
