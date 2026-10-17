"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { users } from "@/db/schema";
import { parseLocale } from "@/i18n/locales";
import { getCurrentUser } from "@/server/auth";
import { setLocaleCookie } from "@/server/locale";

/** Switch the interface language; signed-in users keep the choice on other devices too. */
export async function setLocaleAction(value: string): Promise<void> {
  const locale = parseLocale(value);
  if (!locale) return;
  await setLocaleCookie(locale);
  const user = await getCurrentUser();
  if (user && user.locale !== locale) await db.update(users).set({ locale }).where(eq(users.id, user.id));
  revalidatePath("/", "layout");
}
