import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, elevenLabsKeys, voices, type ElevenLabsKey } from "@/db/schema";
import { config } from "@/lib/config";
import { UserError } from "@/lib/errors";
import { syncAgent } from "./agents";
import { elevenLabs, ElevenLabsError, type ElevenLabsAccount } from "./elevenlabs";
import { decryptSecret, encryptSecret } from "./secrets";
import { voiceProvider } from "./telnyx";

/**
 * Bring-your-own-key ElevenLabs (docs/elevenlabs-notes.md §5). The key is kept twice: encrypted
 * here, because we clone, delete and preview voices with it, and as a Telnyx integration secret,
 * which assistants reference so Telnyx can speak with the user's ElevenLabs voices on calls.
 */

/** How long a key check is trusted before calls check again. */
const KEY_CHECK_TTL_MS = 5 * 60 * 1000;

export async function getElevenLabsKey(userId: string): Promise<ElevenLabsKey | null> {
  const [row] = await db.select().from(elevenLabsKeys).where(eq(elevenLabsKeys.userId, userId));
  return row ?? null;
}

/** The user's ElevenLabs key in plain text; a UserError if they haven't connected one. */
export async function requireElevenLabsApiKey(userId: string): Promise<string> {
  const row = await getElevenLabsKey(userId);
  if (!row) throw new UserError("elevenLabsNotConnected");
  return decryptSecret(row.keyEncrypted);
}

/** Turn an ElevenLabs failure into something the key's owner can act on. */
export function elevenLabsUserError(err: unknown, action: "check" | "clone"): UserError | unknown {
  if (!(err instanceof ElevenLabsError)) return err;
  if (err.status === 401) {
    return new UserError("elevenLabsKeyRefused", { detail: err.detail });
  }
  if (err.status === 429) return new UserError("elevenLabsBusy");
  if (err.status >= 400 && err.status < 500) return new UserError(action === "check" ? "elevenLabsCheckFailed" : "elevenLabsCloneFailed", { detail: err.detail });
  return err;
}

async function checkAccount(apiKey: string): Promise<ElevenLabsAccount> {
  let account: ElevenLabsAccount;
  try {
    account = await elevenLabs().getAccount(apiKey);
  } catch (err) {
    throw elevenLabsUserError(err, "check");
  }
  if (!account.canClone) {
    throw new UserError("elevenLabsNoCloning");
  }
  return account;
}

/**
 * Connect a key, or replace the connected one with another key for the same ElevenLabs account
 * (clones live in that account, so a different account would leave them unusable).
 */
export async function connectElevenLabs(userId: string, rawKey: string): Promise<ElevenLabsKey> {
  if (!config.features.elevenLabs) throw new UserError("elevenLabsUnavailable");
  const apiKey = rawKey.trim();
  if (!apiKey) throw new UserError("apiKeyRequired");
  const existing = await getElevenLabsKey(userId);
  const account = await checkAccount(apiKey);
  if (existing && existing.accountId !== account.accountId) {
    throw new UserError("elevenLabsOtherAccount");
  }

  const telnyxSecretRef = `elevenlabs_${userId.replaceAll("-", "")}_${randomBytes(4).toString("hex")}`;
  const secret = await voiceProvider().createIntegrationSecret(telnyxSecretRef, apiKey);
  const values = {
    keyEncrypted: encryptSecret(apiKey),
    keyCheckedAt: new Date(),
    keyInvalidAt: null,
    keyHint: apiKey.slice(-4),
    accountId: account.accountId,
    telnyxSecretId: secret.id,
    telnyxSecretRef,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(elevenLabsKeys)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: elevenLabsKeys.userId, set: values })
    .returning();

  if (existing) {
    // Point agents at the new secret before the old one goes away.
    for (const a of await agentsUsingElevenLabs(userId)) await syncAgent(a);
    await deleteTelnyxSecret(existing.telnyxSecretId);
  }
  return row;
}

/**
 * Forget the key. Clones made with it stay in the user's ElevenLabs account but are removed
 * here. Refused while an agent still speaks with one of them.
 */
export async function disconnectElevenLabs(userId: string): Promise<void> {
  const existing = await getElevenLabsKey(userId);
  if (!existing) return;
  if ((await agentsUsingElevenLabs(userId)).length) {
    throw new UserError("elevenLabsVoiceInUse");
  }
  await db.transaction(async (tx) => {
    await tx
      .update(voices)
      .set({ deletedAt: new Date() })
      .where(and(eq(voices.userId, userId), eq(voices.provider, "elevenlabs"), isNull(voices.deletedAt)));
    await tx.delete(elevenLabsKeys).where(eq(elevenLabsKeys.userId, userId));
  });
  await deleteTelnyxSecret(existing.telnyxSecretId);
}

/** Whether ElevenLabs rejected the key (status 401): revoked, expired, or missing a permission. */
export function isKeyRejection(err: unknown): boolean {
  return err instanceof ElevenLabsError && err.status === 401;
}

/** Record what ElevenLabs said about the key, whenever we learn it (checks, clones, previews). */
export async function recordKeyStatus(userId: string, rejected: boolean): Promise<void> {
  const now = new Date();
  await db
    .update(elevenLabsKeys)
    .set(rejected ? { keyCheckedAt: now, keyInvalidAt: sql`coalesce(${elevenLabsKeys.keyInvalidAt}, ${now.toISOString()}::timestamptz)` } : { keyCheckedAt: now, keyInvalidAt: null })
    .where(eq(elevenLabsKeys.userId, userId));
}

/**
 * Whether calls with the user's ElevenLabs voices can go ahead. Asks ElevenLabs at most every few
 * minutes; only a definite rejection blocks calls (network trouble or ElevenLabs outages don't).
 * A key that recovers (e.g. permissions restored) is picked up on the next check.
 */
export async function elevenLabsKeyUsable(userId: string): Promise<boolean> {
  const row = await getElevenLabsKey(userId);
  if (!row) return false;
  if (row.keyCheckedAt && Date.now() - row.keyCheckedAt.getTime() < KEY_CHECK_TTL_MS) return !row.keyInvalidAt;
  try {
    await elevenLabs().checkKey(decryptSecret(row.keyEncrypted));
    await recordKeyStatus(userId, false);
    return true;
  } catch (err) {
    if (isKeyRejection(err)) {
      await recordKeyStatus(userId, true);
      return false;
    }
    console.error("ElevenLabs key check failed; allowing the call", userId, err);
    return !row.keyInvalidAt;
  }
}

async function agentsUsingElevenLabs(userId: string) {
  const elVoices = db
    .select({ id: voices.id })
    .from(voices)
    .where(and(eq(voices.userId, userId), eq(voices.provider, "elevenlabs")));
  return db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), isNull(agents.deletedAt), inArray(agents.voiceId, elVoices)));
}

async function deleteTelnyxSecret(id: string) {
  try {
    await voiceProvider().deleteIntegrationSecret(id);
  } catch (err) {
    console.error("deleteIntegrationSecret failed", id, err);
  }
}
