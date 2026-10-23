"use server";

import { revalidatePath } from "next/cache";
import { getLocale, getTranslations } from "next-intl/server";
import { attempt, type ActionState } from "@/lib/action";
import { formatPhone } from "@/lib/format";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { showStored } from "@/lib/stored-text";
import { requireUser } from "@/server/auth";
import { assignAgentToNumber, getActiveUserNumber, purchaseNumber, releaseNumber } from "@/server/numbers";

export async function buyNumberAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    const n = await purchaseNumber(user, String(form.get("e164")));
    revalidatePath("/", "layout");
    if (n.status === "failed") {
      throw new UserError("orderFailed", { reason: showStored(await getLocale(), n.failureReason ?? "", n.failureMsg) });
    }
    const t = await getTranslations("numbers");
    return n.status === "active" ? t("bought", { number: formatPhone(n.e164) }) : t("ordered");
  });
}

export async function assignAgentAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    const agentId = String(form.get("agentId") || "") || null;
    await assignAgentToNumber(user.id, String(form.get("numberId")), agentId);
    revalidatePath("/", "layout");
    const t = await getTranslations("numbers");
    return agentId ? t("agentConnected") : t("agentDisconnected");
  });
}

export async function releaseNumberAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    await releaseNumber(user.id, String(form.get("numberId")));
    revalidatePath("/", "layout");
  });
}

// The simulations run the real webhook handlers, which charge whoever owns the number, so the number
// must be one of the caller's.

export async function simulateInboundAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    if (config.telnyx.mode !== "mock") throw new UserError("mockOnly");
    const n = await getActiveUserNumber(user.id, String(form.get("numberId")));
    const { simulateInboundCall } = await import("@/server/telnyx/mock");
    simulateInboundCall("+12025550123", n.e164);
    return (await getTranslations("numbers"))("simulatedCall");
  });
}

export async function simulateTextAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    if (config.telnyx.mode !== "mock") throw new UserError("mockOnly");
    const n = await getActiveUserNumber(user.id, String(form.get("numberId")));
    const { simulateInboundMessage } = await import("@/server/telnyx/mock");
    await simulateInboundMessage("+12025550123", n.e164, "Hi! Your table for 2 at 7pm tonight is confirmed. Reply C to cancel.");
    revalidatePath("/", "layout");
    return (await getTranslations("numbers"))("simulatedText");
  });
}
