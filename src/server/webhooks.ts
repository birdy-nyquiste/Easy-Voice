import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookEvents } from "@/db/schema";

/**
 * Skip provider events that were already processed. An event is recorded only after `fn` succeeds:
 * recording it first would turn a crash, timeout or failed cleanup into a permanently dropped event,
 * because every redelivery would be answered as a duplicate. So a redelivery that arrives while the
 * first attempt is still running is processed too, and every handler must be safe to run twice
 * (state-guarded updates, per-item ledger keys, insert-if-absent).
 */
export async function withWebhookDedupe(
  provider: "telnyx" | "stripe",
  eventId: string,
  eventType: string,
  fn: () => Promise<void>,
): Promise<void> {
  const [seen] = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.eventId, eventId)));
  if (seen) return; // duplicate delivery
  await fn();
  await db.insert(webhookEvents).values({ provider, eventId, eventType }).onConflictDoNothing();
}
