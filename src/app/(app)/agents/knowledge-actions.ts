"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { attempt, type ActionState } from "@/lib/action";
import { requireUser } from "@/server/auth";
import { addFileSource, addTextSource, addUrlSource, deleteSource, setKnowledgeMode } from "@/server/knowledge";

async function run(form: FormData, fn: (userId: string, agentId: string) => Promise<unknown>, done?: "added" | "deleted") {
  return attempt(async () => {
    const user = await requireUser();
    const agentId = String(form.get("agentId") ?? "");
    await fn(user.id, agentId);
    revalidatePath(`/agents/${agentId}`);
    // The balance in the sidebar changes when a source is charged or refunded.
    revalidatePath("/", "layout");
    if (done) return (await getTranslations("knowledge"))(done);
    return (await getTranslations("common"))("saved");
  });
}

export async function addKnowledgeTextAction(_: ActionState, form: FormData): Promise<ActionState> {
  return run(form, (userId, agentId) => addTextSource(userId, agentId, { title: form.get("title"), text: form.get("text") }), "added");
}

export async function addKnowledgeFileAction(_: ActionState, form: FormData): Promise<ActionState> {
  const file = form.get("file");
  return run(form, (userId, agentId) => addFileSource(userId, agentId, file instanceof File ? file : null), "added");
}

export async function addKnowledgeUrlAction(_: ActionState, form: FormData): Promise<ActionState> {
  return run(form, (userId, agentId) => addUrlSource(userId, agentId, form.get("url")), "added");
}

export async function deleteKnowledgeSourceAction(_: ActionState, form: FormData): Promise<ActionState> {
  return run(form, (userId) => deleteSource(userId, String(form.get("sourceId") ?? "")), "deleted");
}

export async function setKnowledgeModeAction(_: ActionState, form: FormData): Promise<ActionState> {
  return run(form, (userId, agentId) => setKnowledgeMode(userId, agentId, form.get("mode")));
}
