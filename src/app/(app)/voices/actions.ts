"use server";

import { revalidatePath } from "next/cache";
import { getLocale, getTranslations } from "next-intl/server";
import { attempt, type ActionState } from "@/lib/action";
import { UserError } from "@/lib/errors";
import { showStored } from "@/lib/stored-text";
import { toLanguage } from "@/lib/language";
import { requireUser } from "@/server/auth";
import { cloneVoice, deleteVoice } from "@/server/voices";

export async function cloneVoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    const audio = form.get("audio");
    if (!(audio instanceof File)) throw new UserError("audioRequired");
    const v = await cloneVoice(user.id, {
      name: String(form.get("name") ?? ""),
      language: toLanguage(form.get("language")),
      gender: form.get("gender") === "male" ? "male" : "female",
      audio,
      consent: form.get("consent") === "on",
      provider: form.get("provider") === "elevenlabs" ? "elevenlabs" : "telnyx",
    });
    revalidatePath("/", "layout");
    if (v.status === "failed") {
      throw new UserError(v.provider === "elevenlabs" ? "cloneFailed" : "cloneFailedRefunded", {
        reason: showStored(await getLocale(), v.failureReason ?? "", v.failureMsg),
      });
    }
    const t = await getTranslations("voices");
    return v.status === "ready" ? t("cloned") : t("cloneStarted");
  });
}

export async function deleteVoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    await deleteVoice(user.id, String(form.get("voiceId")));
    revalidatePath("/voices");
  });
}
