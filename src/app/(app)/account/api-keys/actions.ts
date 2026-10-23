"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { attempt, type ActionState } from "@/lib/action";
import { UserError } from "@/lib/errors";
import { requireUser } from "@/server/auth";
import { connectElevenLabs, disconnectElevenLabs } from "@/server/elevenlabs-keys";

export async function connectElevenLabsAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    const { agentsNotMoved, previousKeyKept } = await connectElevenLabs(user.id, String(form.get("apiKey") ?? ""));
    revalidatePath("/", "layout");
    // The new key is in place either way, but these need the user to act, so they show as errors.
    if (agentsNotMoved) throw new UserError("elevenLabsAgentsNotMoved", { count: agentsNotMoved });
    if (previousKeyKept) throw new UserError("elevenLabsPreviousKeyKept");
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
