"use server";

import { revalidatePath } from "next/cache";
import { attempt, type ActionState } from "@/lib/action";
import { UserError } from "@/lib/errors";
import { requireUser } from "@/server/auth";
import { cloneVoice, deleteVoice } from "@/server/voices";

export async function cloneVoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    const audio = form.get("audio");
    if (!(audio instanceof File)) throw new UserError("Upload or record an audio sample.");
    const v = await cloneVoice(user.id, {
      name: String(form.get("name") ?? ""),
      language: form.get("language") === "zh" ? "zh" : "en",
      gender: form.get("gender") === "male" ? "male" : "female",
      audio,
      consent: form.get("consent") === "on",
    });
    revalidatePath("/", "layout");
    if (v.status === "failed") throw new UserError(`Cloning failed: ${v.failureReason} You were refunded.`);
    return "Cloning started. It's usually ready within a minute.";
  });
}

export async function deleteVoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    await deleteVoice(user.id, String(form.get("voiceId")));
    revalidatePath("/voices");
  });
}
