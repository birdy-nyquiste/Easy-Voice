import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { ledgerEntries, messages, phoneNumbers, users } from "@/db/schema";
import {
  countUnreadMessages,
  deleteConversation,
  enablePendingInboundSms,
  getContactName,
  handleInboundMessage,
  getConversation,
  listConversations,
  markConversationRead,
  purgeExpiredMessages,
  setContactName,
} from "@/server/messages";
import { parseTelnyxEnvelope } from "@/server/telnyx/events";
import { mockProvider } from "@/server/telnyx/mock";
import type { InboundMessageEvent } from "@/server/telnyx";
import { makeLine, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

let seq = 0;
function text(to: string, fields: Partial<InboundMessageEvent> = {}): InboundMessageEvent {
  seq++;
  return {
    id: `evt-msg-${seq}`,
    type: "message.received",
    rawType: "message.received",
    occurredAt: new Date(),
    messageId: `msg-${seq}`,
    from: "+12025550123",
    to,
    text: "hello",
    parts: 1,
    mediaCount: 0,
    ...fields,
  };
}

async function balance(userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  return u.balanceCents;
}

describe("message.received webhook parsing", () => {
  it("reads the object-shaped from/to and counts media", () => {
    const e = parseTelnyxEnvelope({
      data: {
        id: "evt-1",
        event_type: "message.received",
        occurred_at: "2026-10-16T10:00:00Z",
        payload: {
          id: "msg-1",
          direction: "inbound",
          from: { phone_number: "+12025550123", carrier: "T-Mobile" },
          to: [{ phone_number: "+14155550100", status: "webhook_delivered" }],
          text: "你好",
          parts: 1,
          media: [{ url: "https://example.test/a.jpg", content_type: "image/jpeg" }],
          cost: { amount: "0.0040", currency: "USD" },
        },
      },
    });
    expect(e).toMatchObject({
      type: "message.received",
      id: "evt-1",
      messageId: "msg-1",
      from: "+12025550123",
      to: "+14155550100",
      text: "你好",
      parts: 1,
      mediaCount: 1,
      costUsd: "0.0040",
    });
  });

  it("treats call events as call events", () => {
    const e = parseTelnyxEnvelope({ data: { id: "e", event_type: "call.hangup", payload: { call_control_id: "cc" } } });
    expect(e.type).toBe("call.hangup");
  });
});

describe("inbound texts", () => {
  it("stores the text and bills each segment once, even when redelivered", async () => {
    const { user, number } = await makeLine(1000);
    const e = text(number.e164, { parts: 3, costUsd: "0.012" });
    await handleInboundMessage(e);
    await handleInboundMessage(e); // duplicate delivery
    await handleInboundMessage({ ...e, id: "another-event-id" }); // same message, new event id

    const rows = await db.select().from(messages).where(eq(messages.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: "hello", parts: 3, billedCents: 6, providerCostMicros: 12_000, phoneNumberId: number.id });
    expect(await balance(user.id)).toBe(994);
    const charges = await db.select().from(ledgerEntries).where(eq(ledgerEntries.kind, "sms"));
    expect(charges).toHaveLength(1);
  });

  it("still receives and bills when the balance is empty", async () => {
    const { user, number } = await makeLine(0);
    await handleInboundMessage(text(number.e164));
    expect(await balance(user.id)).toBe(-2);
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u.negativeSince).not.toBeNull();
  });

  it("ignores texts to numbers we don't have active", async () => {
    const { user, number } = await makeLine(1000);
    await db.update(phoneNumbers).set({ status: "released" }).where(eq(phoneNumbers.id, number.id));
    await handleInboundMessage(text(number.e164));
    await handleInboundMessage(text("+19995550000"));
    expect(await db.select().from(messages)).toHaveLength(0);
    expect(await balance(user.id)).toBe(1000);
  });
});

describe("conversations", () => {
  it("groups by sender, tracks unread, and deletes content per sender", async () => {
    const { user, number } = await makeLine(1000);
    const t0 = Date.now();
    await handleInboundMessage(text(number.e164, { from: "+12025550001", text: "a1", occurredAt: new Date(t0) }));
    await handleInboundMessage(text(number.e164, { from: "+12025550002", text: "b1", occurredAt: new Date(t0 + 1000) }));
    await handleInboundMessage(text(number.e164, { from: "+12025550001", text: "a2", occurredAt: new Date(t0 + 2000) }));

    const list = await listConversations(user.id);
    expect(list.map((c) => [c.from, c.count, c.unread, c.last.body])).toEqual([
      ["+12025550001", 2, 2, "a2"],
      ["+12025550002", 1, 1, "b1"],
    ]);
    expect(await countUnreadMessages(user.id)).toBe(3);

    const thread = await getConversation(user.id, "+12025550001");
    expect(thread.map((m) => m.body)).toEqual(["a1", "a2"]);
    expect(await countUnreadMessages(user.id)).toBe(3);
    // Only texts the user has seen are marked read; one arriving later stays unread.
    expect(await markConversationRead(user.id, "+12025550001", thread[0].receivedAt)).toBe(1);
    expect(await markConversationRead(user.id, "+12025550001", thread[1].receivedAt)).toBe(1);
    expect(await countUnreadMessages(user.id)).toBe(1);

    // Another user can't see or delete them.
    const other = await makeUser();
    expect(await getConversation(other.id, "+12025550001")).toEqual([]);
    expect(await markConversationRead(other.id, "+12025550002", new Date())).toBe(0);
    await expect(deleteConversation(other.id, "+12025550001")).rejects.toThrow("not found");

    await deleteConversation(user.id, "+12025550001");
    expect((await listConversations(user.id)).map((c) => c.from)).toEqual(["+12025550002"]);
    const deleted = await db.select().from(messages).where(eq(messages.fromNumber, "+12025550001"));
    expect(deleted.every((m) => m.body === null && m.deletedAt)).toBe(true);
    // Billing stays.
    expect(await balance(user.id)).toBe(994);
  });

  it("purges text content past retention", async () => {
    const { number } = await makeLine(1000);
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    await handleInboundMessage(text(number.e164, { text: "old", occurredAt: old }));
    await handleInboundMessage(text(number.e164, { text: "new" }));
    expect(await purgeExpiredMessages(new Date(Date.now() - 30 * 24 * 3600 * 1000))).toBe(1);
    const rows = await db.select().from(messages);
    expect(rows.map((m) => m.body).sort()).toEqual(["new", null].sort());
  });
});

describe("messaging profile setup", () => {
  it("puts active numbers on the profile and retries failures later", async () => {
    const { number } = await makeLine(1000);
    const spy = vi.spyOn(mockProvider, "enableInboundMessaging").mockRejectedValueOnce(new Error("telnyx 503"));
    expect(await enablePendingInboundSms()).toBe(0);
    let [n] = await db.select().from(phoneNumbers).where(eq(phoneNumbers.id, number.id));
    expect(n.smsEnabledAt).toBeNull();

    expect(await enablePendingInboundSms()).toBe(1);
    expect(spy).toHaveBeenLastCalledWith(number.e164);
    [n] = await db.select().from(phoneNumbers).where(eq(phoneNumbers.id, number.id));
    expect(n.smsEnabledAt).not.toBeNull();
    expect(await enablePendingInboundSms()).toBe(0); // already done
  });
});

describe("contact names", () => {
  it("names a sender per user, renames, and clears with an empty name", async () => {
    const { user, number } = await makeLine(1000);
    const other = await makeUser();
    await handleInboundMessage(text(number.e164, { from: "+12025550001" }));

    await setContactName(user.id, "+12025550001", "  Dr.   Lee's office ");
    expect((await listConversations(user.id))[0].name).toBe("Dr. Lee's office");
    expect(await getContactName(other.id, "+12025550001")).toBeUndefined();

    await setContactName(user.id, "+12025550001", "Dentist");
    expect(await getContactName(user.id, "+12025550001")).toBe("Dentist");

    await setContactName(user.id, "+12025550001", "   ");
    expect(await getContactName(user.id, "+12025550001")).toBeUndefined();
    expect((await listConversations(user.id))[0].name).toBeUndefined();
  });

  it("rejects overly long names", async () => {
    const user = await makeUser();
    await expect(setContactName(user.id, "+12025550001", "x".repeat(61))).rejects.toThrow("under 60");
  });
});
