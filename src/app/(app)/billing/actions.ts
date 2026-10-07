"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, type ActionState } from "@/lib/action";
import { requireUser } from "@/server/auth";
import { addDevCredit, createTopup } from "@/server/billing/payments";

export async function topupAction(_: ActionState, form: FormData): Promise<ActionState> {
  let url = "";
  const result = await attempt(async () => {
    const user = await requireUser();
    const dollars = Number(form.get("amount"));
    url = await createTopup(user, Math.round(dollars * 100));
  });
  if (url) redirect(url);
  return result;
}

export async function devCreditAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    await addDevCredit(user, Math.round(Number(form.get("amount")) * 100));
    revalidatePath("/", "layout");
    return "Dev credit added.";
  });
}
