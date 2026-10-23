"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { attempt, type ActionState } from "@/lib/action";
import { requireUser } from "@/server/auth";
import { addFileSource, addTextSource, addUrlSource, deleteSource, setKnowledgeMode } from "@/server/knowledge";

/**
 * `fn` returns the success message, if any. Adds and deletes have none: the new row (or the row going
 * away) is the confirmation, and the same response remounts or removes the form that would show it.
 */
async function run(form: FormData, fn: (userId: string, agentId: string) => Promise<string | void>) {
  return attempt(async () => {
    const user = await requireUser();
    const agentId = String(form.get("agentId") ?? "");
    const message = await fn(user.id, agentId);
    revalidatePath(`/agents/${agentId}`);
    // The balance in the sidebar changes when a source is charged or refunded.
    revalidatePath("/", "layout");
    return message;
  });
}

export async function addKnowledgeTextAction(_: ActionState, form: FormData): Promise<ActionState> {
  return run(form, async (userId, agentId) => {
    await addTextSource(userId, agentId, { title: form.get("title"), text: form.get("text") });
  });
}

export async function addKnowledgeFileAction(_: ActionState, form: FormData): Promise<ActionState> {
  const file = form.get("file");
  return run(form, async (userId, agentId) => {
    await addFileSource(userId, agentId, file instanceof File ? file : null);
  });
}

export async function addKnowledgeUrlAction(_: ActionState, form: FormData): Promise<ActionState> {
  return run(form, async (userId, agentId) => {
    await addUrlSource(userId, agentId, form.get("url"));
  });
}

export async function deleteKnowledgeSourceAction(_: ActionState, form: FormData): Promise<ActionState> {
  return run(form, (userId) => deleteSource(userId, String(form.get("sourceId") ?? "")));
}

export async function setKnowledgeModeAction(_: ActionState, form: FormData): Promise<ActionState> {
  return run(form, async (userId, agentId) =>
    (await setKnowledgeMode(userId, agentId, form.get("mode")))
      ? (await getTranslations("common"))("saved")
      : (await getTranslations("knowledge"))("modeNotApplied"),
  );
}
