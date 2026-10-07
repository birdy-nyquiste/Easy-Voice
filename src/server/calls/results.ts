import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { calls, type Call } from "@/db/schema";
import { voiceProvider } from "@/server/telnyx";
import { callRef } from "./state";

/** Transcripts/summaries are produced asynchronously by the provider after hangup. */
export async function fetchCallResults(call: Call): Promise<Call> {
  const ref = callRef(call);
  if (call.resultsFetched || call.purgedAt || !call.endedAt || !ref) return call;
  try {
    const res = await voiceProvider().getCallResults(ref);
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

/**
 * Best-effort early fetch on long-lived servers. Serverless hosts may drop it;
 * the call page and the daily cron fetch anything still missing.
 */
export function fetchCallResultsSoon(callId: string): void {
  setTimeout(async () => {
    const [call] = await db.select().from(calls).where(eq(calls.id, callId));
    if (call) await fetchCallResults(call);
  }, 5000);
}
