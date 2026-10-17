"use server";

import { revalidatePath } from "next/cache";
import { attempt, type ActionState } from "@/lib/action";
import { requireUser } from "@/server/auth";
import { connectElevenLabs, disconnectElevenLabs } from "@/server/elevenlabs-keys";

export async function connectElevenLabsAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    await connectElevenLabs(user.id, String(form.get("apiKey") ?? ""));
    revalidatePath("/", "layout");
    return "ElevenLabs connected. You can now clone voices with it on the Voices page.";
  });
}

export async function disconnectElevenLabsAction(): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    await disconnectElevenLabs(user.id);
    revalidatePath("/", "layout");
  });
}
