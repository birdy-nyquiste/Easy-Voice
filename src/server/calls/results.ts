import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { calls, type Call } from "@/db/schema";
import { voiceProvider } from "@/server/telnyx";

/** Transcripts/summaries are produced asynchronously by the provider after hangup. */
export async function fetchCallResults(call: Call): Promise<Call> {
  if (call.resultsFetched || !call.endedAt || !call.providerCallControlId) return call;
  try {
    const res = await voiceProvider().getCallResults(callRef(call));
    if (!res) return call;
    const [u] = await db
      .update(calls)
      .set({ transcript: res.transcript, summary: res.summary ?? null, resultsFetched: true })
      .where(eq(calls.id, call.id))
      .returning();
    return u;
  } catch (err) {
    console.error("getCallResults failed", call.id, err);
    return call;
  }
}

export function callRef(call: Call) {
  return {
    callControlId: call.providerCallControlId ?? "",
    callSessionId: call.providerCallSessionId,
    conversationId: call.providerConversationId,
  };
}

export function fetchCallResultsSoon(callId: string, delayMs = 5000): void {
  setTimeout(async () => {
    const [call] = await db.select().from(calls).where(eq(calls.id, callId));
    if (call) await fetchCallResults(call);
  }, delayMs);
}
