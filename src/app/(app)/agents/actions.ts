"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, type ActionState } from "@/lib/action";
import { UserError } from "@/lib/errors";
import { createAgent, deleteAgent, updateAgent } from "@/server/agents";
import { requireUser } from "@/server/auth";

function fields(form: FormData) {
  return {
    name: form.get("name"),
    instructions: form.get("instructions"),
    greeting: form.get("greeting"),
    language: form.get("language"),
    voice: form.get("voice"),
  };
}

export async function saveAgentAction(_: ActionState, form: FormData): Promise<ActionState> {
  let id = String(form.get("id") ?? "");
  const result = await attempt(async () => {
    const user = await requireUser();
    const agent = id ? await updateAgent(user.id, id, fields(form)) : await createAgent(user.id, fields(form));
    id = agent.id;
    revalidatePath("/", "layout");
    if (agent.status === "failed") throw new UserError(agent.failureReason ?? "Saving failed.");
    return "Saved.";
  });
  if (result?.ok && !form.get("id")) redirect(`/agents/${id}`);
  return result;
}

export async function deleteAgentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const result = await attempt(async () => {
    const user = await requireUser();
    await deleteAgent(user.id, String(form.get("id")));
    revalidatePath("/", "layout");
  });
  if (!result?.error) redirect("/agents");
  return result;
}
