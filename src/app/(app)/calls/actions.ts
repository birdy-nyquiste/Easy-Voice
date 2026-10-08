"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, type ActionState } from "@/lib/action";
import { requireUser } from "@/server/auth";
import { deleteCallRecord, hangupCall, startOutboundCall } from "@/server/calls";

export async function startCallAction(_: ActionState, form: FormData): Promise<ActionState> {
  let callId = "";
  const result = await attempt(async () => {
    const user = await requireUser();
    const call = await startOutboundCall(user, {
      agentId: String(form.get("agentId")),
      to: String(form.get("to") ?? ""),
      goal: String(form.get("goal") ?? ""),
    });
    callId = call.id;
  });
  if (callId) redirect(`/calls/${callId}`);
  return result;
}

export async function hangupAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    await hangupCall(user.id, String(form.get("id")));
    return "Hanging up…";
  });
}

export async function deleteCallAction(_: ActionState, form: FormData): Promise<ActionState> {
  const result = await attempt(async () => {
    const user = await requireUser();
    await deleteCallRecord(user.id, String(form.get("id")));
    revalidatePath("/calls");
  });
  if (!result?.error) redirect("/calls");
  return result;
}
