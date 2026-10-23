"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Agent } from "@/db/schema";
import { attempt, type ActionState } from "@/lib/action";
import { createAgent, deleteAgent, updateAgent } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { cleanUpKnowledge } from "@/server/knowledge";

function fields(form: FormData) {
  const checked = (name: string) => form.get(name) === "on";
  return {
    name: form.get("name"),
    instructions: form.get("instructions"),
    greeting: form.get("greeting"),
    language: form.get("language"),
    voice: form.get("voice"),
    model: form.get("model") ?? undefined,
    behavior: {
      voiceSpeed: form.get("voiceSpeed"),
      backgroundSound: form.get("backgroundSound"),
      responseTiming: form.get("responseTiming"),
      allowInterruptions: checked("allowInterruptions"),
      greetingInterruptible: checked("greetingInterruptible"),
      keyTerms: form.get("keyTerms") ?? "",
      endCallWhenDone: checked("endCallWhenDone"),
      maxCallMinutes: form.get("maxCallMinutes"),
      silenceHangupSecs: form.get("silenceHangupSecs"),
      timeZone: form.get("timeZone"),
    },
    variables: variablesField(form.get("variables")),
  };
}

/** The variable editor posts its rows as JSON; rows left completely empty are dropped. */
function variablesField(raw: FormDataEntryValue | null): unknown {
  try {
    const rows = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(rows) ? rows.filter((r) => r && (String(r.key ?? "").trim() || String(r.value ?? "").trim())) : [];
  } catch {
    return [];
  }
}

export async function saveAgentAction(_: ActionState, form: FormData): Promise<ActionState> {
  let id = String(form.get("id") ?? "");
  let status: Agent["status"] | undefined;
  const result = await attempt(async () => {
    const user = await requireUser();
    const agent = id ? await updateAgent(user.id, id, fields(form)) : await createAgent(user.id, fields(form));
    ({ id, status } = agent);
    revalidatePath("/", "layout");
  });
  // Once saved, the agent page remounts its form (see agents/[id]/page.tsx), which would drop this
  // action's state, so the page shows the outcome: "Saved." via the URL, or why the sync failed.
  // A new agent that failed to sync is saved too: going to it makes saving again update it
  // instead of creating a duplicate.
  if (status) redirect(status === "ready" ? `/agents/${id}?saved=1` : `/agents/${id}`);
  return result;
}

export async function deleteAgentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const result = await attempt(async () => {
    const user = await requireUser();
    const agentId = String(form.get("id"));
    await deleteAgent(user.id, agentId);
    // Remove the agent's knowledge base at the provider now; the daily job retries what fails.
    await cleanUpKnowledge({ agentId }).catch((err) => console.error("knowledge cleanup failed", agentId, err));
    revalidatePath("/", "layout");
  });
  if (!result?.error) redirect("/agents");
  return result;
}
