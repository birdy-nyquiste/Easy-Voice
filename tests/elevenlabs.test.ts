import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { agents, calls, elevenLabsKeys, ledgerEntries, users, voices } from "@/db/schema";
import { createAgent, updateAgent } from "@/server/agents";
import { startOutboundCall } from "@/server/calls";
import { handleCallEvent } from "@/server/calls/events";
import { connectElevenLabs, disconnectElevenLabs } from "@/server/elevenlabs-keys";
import { liveElevenLabs } from "@/server/elevenlabs/live";
import { mockElevenLabs } from "@/server/elevenlabs/mock";
import { ElevenLabsError } from "@/server/elevenlabs/types";
import { decryptSecret, encryptSecret } from "@/server/secrets";
import { mockProvider } from "@/server/telnyx/mock";
import { cloneVoice, deleteVoice, voicePreview } from "@/server/voices";
import { event, makeLine, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const KEY = "sk_acct_alice_1111";
const audio = () => new File([new Uint8Array(5000)], "s.webm", { type: "audio/webm" });
const agentInput = { name: "A", instructions: "Be helpful", greeting: "Hi", language: "en", voice: "stock:Telnyx.KokoroTTS.af_heart" };

async function elevenLabsClone(userId: string) {
  return cloneVoice(userId, { name: "Me", language: "en", gender: "female", audio: audio(), consent: true, provider: "elevenlabs" });
}

describe("secrets", () => {
  it("round-trips, never stores the plain text, and rejects tampering", () => {
    const enc = encryptSecret(KEY);
    expect(enc).not.toContain(KEY);
    expect(decryptSecret(enc)).toBe(KEY);
    const parts = enc.split(":");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
});

describe("connecting ElevenLabs", () => {
  it("checks the key, stores it encrypted and as a Telnyx integration secret", async () => {
    const u = await makeUser();
    const secret = vi.spyOn(mockProvider, "createIntegrationSecret");
    const row = await connectElevenLabs(u.id, `  ${KEY} `);
    expect(row).toMatchObject({ keyHint: "1111", accountId: "alice" });
    expect(row.keyEncrypted).not.toContain(KEY);
    expect(decryptSecret(row.keyEncrypted)).toBe(KEY);
    expect(secret).toHaveBeenCalledWith(row.telnyxSecretRef, KEY);
    expect(row.telnyxSecretRef).toMatch(/^elevenlabs_[0-9a-f]{32}_[0-9a-f]{8}$/);
  });

  it("explains a rejected key or a plan without cloning, and stores nothing", async () => {
    const u = await makeUser();
    await expect(connectElevenLabs(u.id, "sk_invalid")).rejects.toThrow(/ElevenLabs refused the key/);
    await expect(connectElevenLabs(u.id, "sk_free")).rejects.toThrow(/Starter plan/);
    expect(await db.select().from(elevenLabsKeys)).toHaveLength(0);
  });

  it("replaces a key for the same account: agents move to the new secret, the old one is deleted", async () => {
    const u = await makeUser();
    const first = await connectElevenLabs(u.id, KEY);
    const clone = await elevenLabsClone(u.id);
    await createAgent(u.id, { ...agentInput, voice: `clone:${clone.id}` });
    const update = vi.spyOn(mockProvider, "updateAssistant");
    const del = vi.spyOn(mockProvider, "deleteIntegrationSecret");

    const second = await connectElevenLabs(u.id, "sk_acct_alice_2222");
    expect(second.keyHint).toBe("2222");
    expect(second.telnyxSecretRef).not.toBe(first.telnyxSecretRef);
    expect(update.mock.calls[0][1].voiceApiKeyRef).toBe(second.telnyxSecretRef);
    expect(del).toHaveBeenCalledWith(first.telnyxSecretId);
  });

  it("refuses a key for a different ElevenLabs account", async () => {
    const u = await makeUser();
    await connectElevenLabs(u.id, KEY);
    await expect(connectElevenLabs(u.id, "sk_acct_bob_3333")).rejects.toThrow(/different ElevenLabs account/);
    const [row] = await db.select().from(elevenLabsKeys);
    expect(row.keyHint).toBe("1111");
  });

  it("can be switched off", async () => {
    vi.stubEnv("ELEVENLABS", "off");
    const u = await makeUser();
    await expect(connectElevenLabs(u.id, KEY)).rejects.toThrow(/temporarily unavailable/);
  });
});

describe("cloning with ElevenLabs", () => {
  it("is ready at once, uses the Flash voice string, and costs nothing here", async () => {
    const u = await makeUser(); // zero balance
    await connectElevenLabs(u.id, KEY);
    const v = await elevenLabsClone(u.id);
    expect(v).toMatchObject({ provider: "elevenlabs", status: "ready" });
    expect(v.voiceRef).toBe(`ElevenLabs.eleven_flash_v2_5.${v.providerVoiceId}`);
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, u.id))).toHaveLength(0);
  });

  it("works while Telnyx cloning is switched off", async () => {
    vi.stubEnv("VOICE_CLONING", "off");
    const u = await makeUser();
    await connectElevenLabs(u.id, KEY);
    expect((await elevenLabsClone(u.id)).status).toBe("ready");
  });

  it("needs a connected account", async () => {
    const u = await makeUser();
    await expect(elevenLabsClone(u.id)).rejects.toThrow(/Connect your ElevenLabs account/);
  });

  it("records ElevenLabs' reason when a clone fails, without a refund", async () => {
    const u = await makeUser();
    await connectElevenLabs(u.id, KEY);
    vi.spyOn(mockElevenLabs, "cloneVoice").mockRejectedValue(new ElevenLabsError(400, "voice_limit_reached", "You have reached your voice limit."));
    const v = await elevenLabsClone(u.id);
    expect(v).toMatchObject({ status: "failed", failureReason: "ElevenLabs couldn't clone this sample: You have reached your voice limit." });
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, u.id))).toHaveLength(0);
  });

  it("counts its own clone limit, separate from Telnyx clones", async () => {
    const u = await makeUser(5000);
    await connectElevenLabs(u.id, KEY);
    await cloneVoice(u.id, { name: "T", language: "en", gender: "female", audio: audio(), consent: true });
    await elevenLabsClone(u.id);
    await elevenLabsClone(u.id);
    await expect(elevenLabsClone(u.id)).rejects.toThrow(/up to 2 cloned voices with ElevenLabs/);
  });

  it("previews by speaking with the user's key, and deletes from their ElevenLabs account", async () => {
    const u = await makeUser();
    await connectElevenLabs(u.id, KEY);
    const v = await elevenLabsClone(u.id);
    const speak = vi.spyOn(mockElevenLabs, "synthesize");
    expect(await voicePreview(u.id, `clone:${v.id}`)).not.toBeNull();
    expect(speak).toHaveBeenCalledWith(KEY, v.providerVoiceId, expect.any(String));

    const del = vi.spyOn(mockElevenLabs, "deleteVoice");
    await deleteVoice(u.id, v.id);
    expect(del).toHaveBeenCalledWith(KEY, v.providerVoiceId);
  });
});

describe("ElevenLabs previews and clones that need care", () => {
  it("never previews another user's clone (it would spend their credits), even once it's cached", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    await connectElevenLabs(owner.id, KEY);
    await connectElevenLabs(other.id, "sk_acct_bob_2222"); // with a key of their own, only the owner check stops it
    const v = await elevenLabsClone(owner.id);
    const speak = vi.spyOn(mockElevenLabs, "synthesize");
    expect(await voicePreview(other.id, `clone:${v.id}`)).toBeNull();
    expect(await voicePreview(owner.id, `clone:${v.id}`)).not.toBeNull(); // now cached
    expect(await voicePreview(other.id, `clone:${v.id}`)).toBeNull();
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("deletes a clone ElevenLabs wants verified, and says why it failed", async () => {
    const u = await makeUser();
    await connectElevenLabs(u.id, KEY);
    vi.spyOn(mockElevenLabs, "cloneVoice").mockResolvedValue({ voiceId: "el_unverified", requiresVerification: true });
    const del = vi.spyOn(mockElevenLabs, "deleteVoice");
    const v = await elevenLabsClone(u.id);
    expect(del).toHaveBeenCalledWith(KEY, "el_unverified");
    expect(v).toMatchObject({ status: "failed", failureMsg: { key: "stored.voiceNeedsVerification" } });
  });

  it("flags the key when ElevenLabs rejects it during a preview", async () => {
    const u = await makeUser();
    await connectElevenLabs(u.id, KEY);
    const v = await elevenLabsClone(u.id);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(mockElevenLabs, "synthesize").mockRejectedValue(new ElevenLabsError(401, "invalid_api_key", "Invalid API key"));
    await expect(voicePreview(u.id, `clone:${v.id}`)).rejects.toBeInstanceOf(ElevenLabsError);
    expect((await db.select().from(elevenLabsKeys))[0].keyInvalidAt).not.toBeNull();
  });
});

describe("agents with ElevenLabs voices", () => {
  it("send the voice with the user's key reference", async () => {
    const u = await makeUser();
    const key = await connectElevenLabs(u.id, KEY);
    const v = await elevenLabsClone(u.id);
    const create = vi.spyOn(mockProvider, "createAssistant");
    const a = await createAgent(u.id, { ...agentInput, voice: `clone:${v.id}` });
    expect(a.status).toBe("ready");
    expect(create.mock.calls[0][0]).toMatchObject({ voiceRef: v.voiceRef, voiceApiKeyRef: key.telnyxSecretRef });
  });

  it("leave other voices without a key reference", async () => {
    const u = await makeUser();
    await connectElevenLabs(u.id, KEY);
    const create = vi.spyOn(mockProvider, "createAssistant");
    await createAgent(u.id, agentInput);
    expect(create.mock.calls[0][0].voiceApiKeyRef).toBeUndefined();
  });

  it("fail with a clear reason when the account isn't connected any more", async () => {
    const u = await makeUser();
    await connectElevenLabs(u.id, KEY);
    const v = await elevenLabsClone(u.id);
    const a = await createAgent(u.id, { ...agentInput, voice: `clone:${v.id}` });
    // Simulate a key row lost outside disconnectElevenLabs (which refuses while agents use it).
    await db.delete(elevenLabsKeys).where(eq(elevenLabsKeys.userId, u.id));
    const again = await updateAgent(u.id, a.id, { ...agentInput, voice: `clone:${v.id}` });
    expect(again).toMatchObject({ status: "failed", failureReason: expect.stringMatching(/ElevenLabs account isn't connected/) });
  });
});

describe("disconnecting ElevenLabs", () => {
  it("is refused while an agent uses an ElevenLabs voice", async () => {
    const u = await makeUser();
    await connectElevenLabs(u.id, KEY);
    const v = await elevenLabsClone(u.id);
    await createAgent(u.id, { ...agentInput, voice: `clone:${v.id}` });
    await expect(disconnectElevenLabs(u.id)).rejects.toThrow(/Change the agent's voice first/);
  });

  it("removes the key, the Telnyx secret and the ElevenLabs voices here, keeping other clones", async () => {
    const u = await makeUser(5000);
    const key = await connectElevenLabs(u.id, KEY);
    const el = await elevenLabsClone(u.id);
    const telnyx = await cloneVoice(u.id, { name: "T", language: "en", gender: "female", audio: audio(), consent: true });
    const a = await createAgent(u.id, { ...agentInput, voice: `clone:${el.id}` });
    await updateAgent(u.id, a.id, agentInput);
    const del = vi.spyOn(mockProvider, "deleteIntegrationSecret");
    const elDelete = vi.spyOn(mockElevenLabs, "deleteVoice");

    await disconnectElevenLabs(u.id);
    expect(await db.select().from(elevenLabsKeys)).toHaveLength(0);
    expect(del).toHaveBeenCalledWith(key.telnyxSecretId);
    expect(elDelete).not.toHaveBeenCalled(); // they stay in the user's ElevenLabs account
    const rows = await db.select().from(voices).where(eq(voices.userId, u.id));
    expect(rows.find((r) => r.id === el.id)?.deletedAt).not.toBeNull();
    expect(rows.find((r) => r.id === telnyx.id)?.deletedAt).toBeNull();
    expect((await db.select().from(agents).where(eq(agents.id, a.id)))[0].status).toBe("ready");
    expect((await db.select().from(users).where(eq(users.id, u.id)))[0]).toBeTruthy();
  });
});

describe("ElevenLabs REST adapter", () => {
  it("gives up on a slow key check quickly, so it can't hold up answering a call", async () => {
    // A request that never answers until it is aborted.
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })));
    const started = Date.now();
    await expect(liveElevenLabs.checkKey("sk_1")).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 8000);

  it("sends the key, reads the account and turns API errors into ElevenLabsError", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "u1" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tier: "starter", can_use_instant_voice_cloning: true })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }), { status: 401 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await liveElevenLabs.getAccount("sk_1")).toEqual({ accountId: "u1", tier: "starter", canClone: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/user");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("sk_1");

    const err = await liveElevenLabs.getAccount("bad").catch((e) => e);
    expect(err).toBeInstanceOf(ElevenLabsError);
    expect(err).toMatchObject({ status: 401, code: "invalid_api_key", detail: "Invalid API key" });
  });

  it("clones with Instant Voice Cloning and treats an already-deleted voice as deleted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ voice_id: "v123", requires_verification: false })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: { status: "voice_not_found", message: "nope" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await liveElevenLabs.cloneVoice("sk_1", { name: "Me", language: "zh", gender: "male", audio: audio() });
    expect(res).toEqual({ voiceId: "v123", requiresVerification: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/voices/add");
    const form = init.body as FormData;
    expect(form.get("name")).toBe("Me");
    expect(form.getAll("files")).toHaveLength(1);
    expect(JSON.parse(String(form.get("labels")))).toEqual({ language: "zh", gender: "male" });

    await expect(liveElevenLabs.deleteVoice("sk_1", "v123")).resolves.toBeUndefined();
  });
});

describe("key health before calls", () => {
  async function elevenLabsLine() {
    const line = await makeLine(1000);
    await connectElevenLabs(line.user.id, KEY);
    await db.update(agents).set({ voiceRef: "ElevenLabs.eleven_flash_v2_5.v1" }).where(eq(agents.id, line.agent.id));
    // Make the connect-time check stale so the next call asks ElevenLabs again.
    await db.update(elevenLabsKeys).set({ keyCheckedAt: new Date(Date.now() - 10 * 60 * 1000) });
    return line;
  }
  const rejected = () => new ElevenLabsError(401, "invalid_api_key", "Invalid API key");
  const keyRow = async () => (await db.select().from(elevenLabsKeys))[0];

  beforeEach(() => {
    vi.spyOn(mockProvider, "dial").mockResolvedValue({ callControlId: "cc-out" });
    vi.spyOn(mockProvider, "answer").mockResolvedValue();
    vi.spyOn(mockProvider, "reject").mockResolvedValue();
  });

  it("refuses an outbound call when ElevenLabs rejects the key, and flags the key", async () => {
    const { user, agent } = await elevenLabsLine();
    vi.spyOn(mockElevenLabs, "checkKey").mockRejectedValue(rejected());
    await expect(startOutboundCall(user, { agentId: agent.id, to: "2025550188" })).rejects.toThrow(/ElevenLabs rejected your API key/);
    expect(mockProvider.dial).not.toHaveBeenCalled();
    expect((await keyRow()).keyInvalidAt).not.toBeNull();
  });

  it("places the call when the key works, and trusts that answer for a few minutes", async () => {
    const { user, agent } = await elevenLabsLine();
    const check = vi.spyOn(mockElevenLabs, "checkKey");
    await startOutboundCall(user, { agentId: agent.id, to: "2025550188" });
    expect(mockProvider.dial).toHaveBeenCalledTimes(1);
    await db.delete(calls); // let a second call through the busy check
    await startOutboundCall(user, { agentId: agent.id, to: "2025550188" });
    expect(check).toHaveBeenCalledTimes(1);
    expect((await keyRow()).keyInvalidAt).toBeNull();
  });

  it("doesn't block calls when ElevenLabs can't be reached", async () => {
    const { user, agent } = await elevenLabsLine();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(mockElevenLabs, "checkKey").mockRejectedValue(new TypeError("fetch failed"));
    await startOutboundCall(user, { agentId: agent.id, to: "2025550188" });
    expect(mockProvider.dial).toHaveBeenCalled();
  });

  it("declines an inbound call with a clear outcome when the key is rejected", async () => {
    const { number } = await elevenLabsLine();
    vi.spyOn(mockElevenLabs, "checkKey").mockRejectedValue(rejected());
    await handleCallEvent(event("call.initiated", { callControlId: "cc-in", direction: "inbound", from: "+12025550123", to: number.e164 }));
    expect(mockProvider.reject).toHaveBeenCalledWith("cc-in", "CALL_REJECTED");
    expect(mockProvider.answer).not.toHaveBeenCalled();
    const [c] = await db.select().from(calls);
    expect(c).toMatchObject({ status: "rejected", outcome: expect.stringMatching(/ElevenLabs rejected your API key/) });
  });

  it("doesn't check agents with other voices", async () => {
    const { user, agent } = await makeLine(1000);
    await connectElevenLabs(user.id, KEY);
    const check = vi.spyOn(mockElevenLabs, "checkKey");
    await startOutboundCall(user, { agentId: agent.id, to: "2025550188" });
    expect(check).not.toHaveBeenCalled();
  });

  it("clears the flag when the key works again, or when it's replaced", async () => {
    const { user, agent } = await elevenLabsLine();
    vi.spyOn(mockElevenLabs, "checkKey").mockRejectedValueOnce(rejected());
    await expect(startOutboundCall(user, { agentId: agent.id, to: "2025550188" })).rejects.toThrow();
    expect((await keyRow()).keyInvalidAt).not.toBeNull();

    await connectElevenLabs(user.id, "sk_acct_alice_2222");
    expect((await keyRow()).keyInvalidAt).toBeNull();

    await db.update(elevenLabsKeys).set({ keyInvalidAt: new Date(), keyCheckedAt: new Date(0) });
    await startOutboundCall(user, { agentId: agent.id, to: "2025550188" });
    expect((await keyRow()).keyInvalidAt).toBeNull();
  });

  it("flags the key when ElevenLabs rejects it during a clone", async () => {
    const u = await makeUser();
    await connectElevenLabs(u.id, KEY);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(mockElevenLabs, "cloneVoice").mockRejectedValue(rejected());
    await elevenLabsClone(u.id);
    expect((await keyRow()).keyInvalidAt).not.toBeNull();
  });
});
