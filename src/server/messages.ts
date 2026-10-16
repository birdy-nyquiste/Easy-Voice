import "server-only";
import { and, asc, desc, eq, isNull, lt, lte } from "drizzle-orm";
import { db } from "@/db";
import { messages, phoneNumbers, type Message, type PhoneNumber } from "@/db/schema";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { applyLedger } from "./billing/ledger";
import { voiceProvider, type InboundMessageEvent } from "./telnyx";
import { withWebhookDedupe } from "./webhooks";

/**
 * Receive-only texting (SPEC §17). Texts are stored and billed per segment; nothing is ever sent,
 * so no 10DLC registration is needed.
 */

/** Store and bill one inbound text. Safe to call repeatedly with the same event. */
export async function handleInboundMessage(e: InboundMessageEvent): Promise<void> {
  await withWebhookDedupe("telnyx", e.id, e.rawType, async () => {
    const [num] = await db
      .select()
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.e164, e.to), eq(phoneNumbers.status, "active")));
    if (!num) {
      console.warn("Text to a number we don't have active", e.to);
      return;
    }
    const usd = Number(e.costUsd);
    const billedCents = e.parts * config.pricing.smsInboundPerPartCents;
    await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(messages)
        .values({
          userId: num.userId,
          phoneNumberId: num.id,
          fromNumber: e.from,
          toNumber: e.to,
          body: e.text,
          parts: e.parts,
          mediaCount: e.mediaCount,
          providerMessageId: e.messageId,
          billedCents,
          providerCostMicros: Number.isFinite(usd) ? Math.round(usd * 1_000_000) : null,
          receivedAt: e.occurredAt,
        })
        .onConflictDoNothing()
        .returning();
      if (!created || billedCents === 0) return;
      // Texts can't be refused, so they're billed even when the balance is empty (it goes negative,
      // and the usual grace-period release applies).
      await applyLedger(
        {
          userId: num.userId,
          amountCents: -billedCents,
          kind: "sms",
          idempotencyKey: `sms:${e.messageId}`,
          description: `Text from ${e.from} (${e.parts} segment${e.parts === 1 ? "" : "s"})`,
          refType: "message",
          refId: created.id,
        },
        tx,
      );
    });
  });
}

/** Put a number on the messaging profile. Failures are logged and retried by the daily cron. */
export async function enableInboundSms(n: Pick<PhoneNumber, "id" | "e164">): Promise<boolean> {
  if (!config.features.inboundSms) return false;
  try {
    await voiceProvider().enableInboundMessaging(n.e164);
  } catch (err) {
    console.error("enableInboundMessaging failed", n.id, err);
    return false;
  }
  await db.update(phoneNumbers).set({ smsEnabledAt: new Date() }).where(eq(phoneNumbers.id, n.id));
  return true;
}

/** Active numbers not yet on the messaging profile (bought before texting existed, or a failed attempt). */
export async function enablePendingInboundSms(): Promise<number> {
  if (!config.features.inboundSms) return 0;
  const pending = await db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.status, "active"), isNull(phoneNumbers.smsEnabledAt)));
  let enabled = 0;
  for (const n of pending) if (await enableInboundSms(n)) enabled++;
  return enabled;
}

export interface Conversation {
  from: string;
  last: Message;
  count: number;
  unread: number;
}

/** Conversations (one per sender), newest first. */
export async function listConversations(userId: string, limit = 500): Promise<Conversation[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.receivedAt))
    .limit(limit);
  const byFrom = new Map<string, Conversation>();
  for (const m of rows) {
    const c = byFrom.get(m.fromNumber) ?? { from: m.fromNumber, last: m, count: 0, unread: 0 };
    c.count++;
    if (!m.readAt) c.unread++;
    byFrom.set(m.fromNumber, c);
  }
  return [...byFrom.values()];
}

export async function countUnreadMessages(userId: string): Promise<number> {
  return db.$count(messages, and(eq(messages.userId, userId), isNull(messages.deletedAt), isNull(messages.readAt)));
}

/** Every text from one sender, oldest first. */
export async function getConversation(userId: string, from: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.fromNumber, from), isNull(messages.deletedAt)))
    .orderBy(asc(messages.receivedAt));
}

/** Marks texts read, up to the newest one the user has seen. Returns how many changed. */
export async function markConversationRead(userId: string, from: string, upTo: Date): Promise<number> {
  const changed = await db
    .update(messages)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.fromNumber, from),
        isNull(messages.readAt),
        isNull(messages.deletedAt),
        lte(messages.receivedAt, upTo),
      ),
    )
    .returning({ id: messages.id });
  return changed.length;
}

/** Deletes the text content of a conversation; billing rows stay. */
export async function deleteConversation(userId: string, from: string): Promise<void> {
  const now = new Date();
  const deleted = await db
    .update(messages)
    .set({ body: null, purgedAt: now, deletedAt: now })
    .where(and(eq(messages.userId, userId), eq(messages.fromNumber, from), isNull(messages.deletedAt)))
    .returning({ id: messages.id });
  if (deleted.length === 0) throw new UserError("Conversation not found.");
}

/** Retention: blank text content older than the cutoff. */
export async function purgeExpiredMessages(cutoff: Date): Promise<number> {
  const purged = await db
    .update(messages)
    .set({ body: null, purgedAt: new Date() })
    .where(and(lt(messages.receivedAt, cutoff), isNull(messages.purgedAt)))
    .returning({ id: messages.id });
  return purged.length;
}
