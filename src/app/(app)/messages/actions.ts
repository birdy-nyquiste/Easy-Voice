"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { attempt, type ActionState } from "@/lib/action";
import { requireUser } from "@/server/auth";
import { deleteConversation, markConversationRead, setContactName } from "@/server/messages";

/** Called once a thread is on screen, so the nav badge (rendered alongside the page) catches up. */
export async function markReadAction(from: string, upTo: string): Promise<void> {
  const user = await requireUser();
  const when = new Date(upTo);
  if (Number.isNaN(when.getTime())) return;
  if (await markConversationRead(user.id, from, when)) revalidatePath("/", "layout");
}

export async function deleteConversationAction(_: ActionState, form: FormData): Promise<ActionState> {
  const result = await attempt(async () => {
    const user = await requireUser();
    await deleteConversation(user.id, String(form.get("from")));
    revalidatePath("/", "layout");
  });
  if (!result?.error) redirect("/messages");
  return result;
}

export async function saveContactNameAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    const name = String(form.get("name") ?? "");
    await setContactName(user.id, String(form.get("number") ?? ""), name);
    revalidatePath("/messages", "layout");
    const t = await getTranslations("messages");
    return name.trim() ? t("nameSaved") : t("nameRemoved");
  });
}
