"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { attempt, type ActionState } from "@/lib/action";
import { requireUser } from "@/server/auth";
import { connectElevenLabs, disconnectElevenLabs } from "@/server/elevenlabs-keys";

export async function connectElevenLabsAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    await connectElevenLabs(user.id, String(form.get("apiKey") ?? ""));
    revalidatePath("/", "layout");
    return (await getTranslations("apiKeys"))("connected");
  });
}

export async function disconnectElevenLabsAction(): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    await disconnectElevenLabs(user.id);
    revalidatePath("/", "layout");
  });
}
