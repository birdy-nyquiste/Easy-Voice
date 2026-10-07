"use server";

import { revalidatePath } from "next/cache";
import { attempt, type ActionState } from "@/lib/action";
import { formatPhone } from "@/lib/format";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { requireUser } from "@/server/auth";
import { assignAgentToNumber, purchaseNumber, releaseNumber } from "@/server/numbers";

export async function buyNumberAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    const n = await purchaseNumber(user, String(form.get("e164")));
    revalidatePath("/", "layout");
    if (n.status === "failed") throw new UserError(`Order failed: ${n.failureReason}. You were refunded.`);
    return n.status === "active" ? `${formatPhone(n.e164)} is yours.` : "Order placed — activating…";
  });
}

export async function assignAgentAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    const agentId = String(form.get("agentId") || "") || null;
    await assignAgentToNumber(user.id, String(form.get("numberId")), agentId);
    revalidatePath("/", "layout");
    return agentId ? "Agent connected." : "Agent disconnected.";
  });
}

export async function releaseNumberAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const user = await requireUser();
    await releaseNumber(user.id, String(form.get("numberId")));
    revalidatePath("/", "layout");
  });
}

export async function simulateInboundAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await requireUser();
    if (config.telnyx.mode !== "mock") throw new UserError("Only available in mock mode.");
    const { simulateInboundCall } = await import("@/server/telnyx/mock");
    simulateInboundCall("+12025550123", String(form.get("e164")));
    return "Simulated call placed — check Calls in a few seconds.";
  });
}
