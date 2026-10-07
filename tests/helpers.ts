import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, phoneNumbers, users } from "@/db/schema";
import { applyLedger } from "@/server/billing/ledger";
import type { CallEvent } from "@/server/telnyx";

export async function resetDb() {
  await db.execute(sql`truncate table users, sessions, email_otps, payments, ledger_entries, phone_numbers, voices, agents, calls, webhook_events restart identity cascade`);
}

export async function makeUser(balanceCents = 0) {
  const [u] = await db.insert(users).values({ email: `${randomUUID()}@test.dev` }).returning();
  if (balanceCents) {
    await applyLedger({ userId: u.id, amountCents: balanceCents, kind: "adjustment", idempotencyKey: `seed:${u.id}`, description: "seed" });
  }
  return u;
}

/** A user with balance, a ready agent, and an active number wired to it. */
export async function makeLine(balanceCents = 1000) {
  const user = await makeUser(balanceCents);
  const [agent] = await db
    .insert(agents)
    .values({
      userId: user.id,
      name: "Test agent",
      instructions: "Be helpful",
      greeting: "Hello",
      language: "en",
      voiceRef: "Telnyx.KokoroTTS.af_heart",
      providerAssistantId: "assistant-test",
      status: "ready",
    })
    .returning();
  const e164 = `+1415${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  const [number] = await db
    .insert(phoneNumbers)
    .values({ userId: user.id, e164, status: "active", agentId: agent.id, providerNumberId: "num_1" })
    .returning();
  return { user, agent, number };
}

let seq = 0;
export function event(type: CallEvent["type"], fields: Partial<CallEvent> = {}): CallEvent {
  return { id: `evt_${++seq}_${randomUUID()}`, type, rawType: type, occurredAt: new Date(), ...fields };
}
