"use server";

import { revalidatePath } from "next/cache";
import { parseLocale } from "@/i18n/locales";
import { getCurrentUser } from "@/server/auth";
import { saveUserLocale, setLocaleCookie } from "@/server/locale";

/** Switch the interface language; signed-in users keep the choice on other devices too. */
export async function setLocaleAction(value: string): Promise<void> {
  const locale = parseLocale(value);
  if (!locale) return;
  await setLocaleCookie(locale);
  const user = await getCurrentUser();
  if (user) await saveUserLocale(user, locale);
  revalidatePath("/", "layout");
}
