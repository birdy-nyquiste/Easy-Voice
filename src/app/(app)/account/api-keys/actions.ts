"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { attempt, type ActionState } from "@/lib/action";
import { requireUser } from "@/server/auth";
import { connectElevenLabs, disconnectElevenLabs } from "@/server/elevenlabs-keys";

export async function connectElevenLabsAction(_: ActionState, form: FormData): Promise<ActionState> {
  let problems: string[] = [];
  const result = await attempt(async () => {
    const user = await requireUser();
    const { agentsNotMoved, previousKeyKept } = await connectElevenLabs(user.id, String(form.get("apiKey") ?? ""));
    revalidatePath("/", "layout");
    // The new key is in place either way, but these need the user to act, so they show as errors, both
    // when both happen (a Telnyx outage during a replacement causes both).
    const te = await getTranslations("errors");
    problems = [
      agentsNotMoved ? te("elevenLabsAgentsNotMoved", { count: agentsNotMoved }) : "",
      previousKeyKept ? te("elevenLabsPreviousKeyKept", { hint: previousKeyKept }) : "",
    ].filter(Boolean);
    return (await getTranslations("apiKeys"))("connected");
  });
  if (result?.ok && problems.length) return { error: problems.join((await getTranslations("common"))("sentenceGap")) };
  return result;
}

export async function disconnectElevenLabsAction(): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    await disconnectElevenLabs(user.id);
    revalidatePath("/", "layout");
  });
}
