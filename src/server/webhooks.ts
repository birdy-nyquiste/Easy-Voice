import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookEvents } from "@/db/schema";

/**
 * Process a provider event at most once. If `fn` throws, the dedupe record is
 * removed so the provider's retry is processed again.
 */
export async function withWebhookDedupe(
  provider: "telnyx" | "stripe",
  eventId: string,
  eventType: string,
  fn: () => Promise<void>,
): Promise<void> {
  const [fresh] = await db
    .insert(webhookEvents)
    .values({ provider, eventId, eventType })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (!fresh) return; // duplicate delivery
  try {
    await fn();
  } catch (err) {
    await db.delete(webhookEvents).where(eq(webhookEvents.id, fresh.id));
    throw err;
  }
}
