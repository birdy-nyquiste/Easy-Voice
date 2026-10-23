import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { agents, voices } from "@/db/schema";
import { MESSAGES } from "@/i18n/messages";
import { DEFAULT_BEHAVIOR, readBehavior, undefinedVariables } from "@/lib/agent-settings";
import { AGENT_TEMPLATES, offeredTemplates, TEMPLATE_IDS } from "@/lib/agent-templates";
import { config } from "@/lib/config";
import { errorText } from "@/lib/errors";
import {
  createAgent,
  deleteAgent,
  deleteLeftoverAssistants,
  ENGLISH_ONLY_VOICE_RULE,
  listUserAgents,
  platformFingerprint,
  resyncStaleAgents,
  resyncStaleAgentsOnView,
  syncAgentQuietly,
  updateAgent,
} from "@/server/agents";
import { mockProvider } from "@/server/telnyx/mock";
import { MOCK_MODELS, toOfferedModels } from "@/server/telnyx/models";
import { FeatureNotPermittedError } from "@/server/telnyx/types";
import { cloneVoice } from "@/server/voices";
import { makeUser, resetDb } from "./helpers";

const CLONING_UNAVAILABLE = errorText("en", "cloningUnavailable");

async function agentRow(id: string) {
  const [a] = await db.select().from(agents).where(eq(agents.id, id));
  return a;
}

const original = { ...config.telnyx };
beforeEach(resetDb);
afterEach(() => {
  Object.assign(config.telnyx, original);
  vi.restoreAllMocks();
});

const input = {
  name: "A",
  instructions: "Be helpful",
  greeting: "Hi",
  language: "en",
  voice: "stock:Telnyx.KokoroTTS.af_heart",
};

describe("platform model settings", () => {
  it("pins the models verified on a live call", () => {
    expect(config.telnyx.llmModel).toBe("moonshotai/Kimi-K2.6");
    expect(config.telnyx.sttModel).toBe("assemblyai/universal-3-5-pro");
  });

  it("records which platform settings an agent was synced with", async () => {
    const u = await makeUser();
    const a = await createAgent(u.id, input);
    expect(a.syncedConfig).toBe(platformFingerprint());
  });

  it("re-syncs only agents saved under different platform settings, once", async () => {
    const u = await makeUser();
    await createAgent(u.id, input);
    const failed = await createAgent(u.id, { ...input, name: "B" });
    await db.update(agents).set({ status: "failed" }).where(eq(agents.id, failed.id));
    const update = vi.spyOn(mockProvider, "updateAssistant");

    expect(await resyncStaleAgents()).toBe(0); // nothing changed yet

    config.telnyx.llmModel = "google/gemini-3.7-flash";
    expect(await resyncStaleAgents()).toBe(1); // the failed agent is left for the user to fix
    expect(update).toHaveBeenCalledTimes(1);
    expect(await resyncStaleAgents()).toBe(0);
  });

  it("re-syncs when what we send to the provider changes (body version)", async () => {
    const u = await makeUser();
    const a = await createAgent(u.id, input);
    await db.update(agents).set({ syncedConfig: "fingerprint-from-older-code" }).where(eq(agents.id, a.id));
    expect(await resyncStaleAgents()).toBe(1);
  });

  it("can scope the re-sync to one user", async () => {
    const [u1, u2] = [await makeUser(), await makeUser()];
    await createAgent(u1.id, input);
    await createAgent(u2.id, input);
    config.telnyx.sttLanguage = "zh";
    expect(await resyncStaleAgents(u1.id)).toBe(1);
    expect(await resyncStaleAgents()).toBe(1);
  });

  describe("on page views", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("re-syncs only on the production deployment, so previews don't push their settings over it", async () => {
      const u = await makeUser();
      const a = await createAgent(u.id, input);
      await db.update(agents).set({ syncedConfig: "fingerprint-of-another-deployment" }).where(eq(agents.id, a.id));
      const update = vi.spyOn(mockProvider, "updateAssistant");
      vi.stubEnv("VERCEL", "1");
      vi.stubEnv("VERCEL_ENV", "preview");
      expect(await resyncStaleAgentsOnView(u.id)).toBe(0);
      expect(update).not.toHaveBeenCalled();
      vi.stubEnv("VERCEL_ENV", "production");
      expect(await resyncStaleAgentsOnView(u.id)).toBe(1);
      expect(update).toHaveBeenCalledTimes(1);
    });
  });

  it("finishes a save that was cut off before its push, and leaves one that may still be running", async () => {
    const u = await makeUser();
    const cutOff = await createAgent(u.id, input);
    const running = await createAgent(u.id, { ...input, name: "B" });
    await db.update(agents).set({ status: "syncing", updatedAt: new Date(Date.now() - 11 * 60 * 1000) }).where(eq(agents.id, cutOff.id));
    await db.update(agents).set({ status: "syncing" }).where(eq(agents.id, running.id));
    const update = vi.spyOn(mockProvider, "updateAssistant");

    expect(await resyncStaleAgents()).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect((await agentRow(cutOff.id)).status).toBe("ready");
    expect((await agentRow(running.id)).status).toBe("syncing");
  });
});

describe("pushes racing a save", () => {
  const greeting = (g: string) => `This call may be recorded. ${g}`;

  it("follows a background push of an older copy with the latest config", async () => {
    const u = await makeUser();
    const a = await createAgent(u.id, input);
    await db.update(agents).set({ syncedConfig: "stale" }).where(eq(agents.id, a.id));
    const olderCopy = await agentRow(a.id);
    await updateAgent(u.id, a.id, { ...input, greeting: "Saved since" });
    const update = vi.spyOn(mockProvider, "updateAssistant");

    expect(await syncAgentQuietly(olderCopy)).toBe(true);
    expect(update.mock.calls.map((c) => c[1].greeting)).toEqual([greeting("Hi"), greeting("Saved since")]);
    expect(await agentRow(a.id)).toMatchObject({ greeting: "Saved since", status: "ready", syncedConfig: platformFingerprint() });
  });

  it("ends on the newer of two overlapping saves, whichever request lands last", async () => {
    const u = await makeUser();
    const a = await createAgent(u.id, input);
    const landed: string[] = [];
    const update = vi.spyOn(mockProvider, "updateAssistant").mockImplementation(async (_id, spec) => {
      landed.push(spec.greeting);
    });
    update.mockImplementationOnce(async (_id, spec) => {
      // A second save (another tab) completes while the first one's request is still on its way.
      await updateAgent(u.id, a.id, { ...input, greeting: "Second" });
      landed.push(spec.greeting);
    });

    const first = await updateAgent(u.id, a.id, { ...input, greeting: "First" });
    expect(landed.at(-1)).toBe(greeting("Second"));
    expect(first).toMatchObject({ greeting: "Second", status: "ready" });
  });
});

describe("agent list", () => {
  it("keeps the order agents were created in, whatever was saved since", async () => {
    const u = await makeUser();
    const a = await createAgent(u.id, { ...input, name: "A" });
    await createAgent(u.id, { ...input, name: "B" });
    await updateAgent(u.id, a.id, { ...input, name: "A, renamed" });
    expect((await listUserAgents(u.id)).map((x) => x.name)).toEqual(["A, renamed", "B"]);
  });
});

describe("deleting an agent", () => {
  it("forgets the assistant once the provider has deleted it", async () => {
    const u = await makeUser();
    const a = await createAgent(u.id, input);
    await deleteAgent(u.id, a.id);
    expect(await agentRow(a.id)).toMatchObject({ deletedAt: expect.any(Date), providerAssistantId: null });
  });

  it("keeps an assistant the provider didn't delete, and the daily job retries it", async () => {
    const u = await makeUser();
    const a = await createAgent(u.id, input);
    const del = vi.spyOn(mockProvider, "deleteAssistant").mockRejectedValueOnce(new Error("timeout"));

    await deleteAgent(u.id, a.id);
    expect(await agentRow(a.id)).toMatchObject({ deletedAt: expect.any(Date), providerAssistantId: a.providerAssistantId });

    expect(await deleteLeftoverAssistants()).toBe(1);
    expect(del).toHaveBeenLastCalledWith(a.providerAssistantId);
    expect((await agentRow(a.id)).providerAssistantId).toBeNull();
    expect(await deleteLeftoverAssistants()).toBe(0);
  });
});

describe("voice languages", () => {
  const hua = "stock:Telnyx.Ultra.7a5d4663-88ae-47b7-808e-8f9b9ee4127b";

  it("rejects an English-only voice for a Mandarin agent", async () => {
    const u = await makeUser();
    await expect(createAgent(u.id, { ...input, language: "zh" })).rejects.toThrow(/can't speak Mandarin/);
  });

  it("tells agents with an English-only voice to reply in English", async () => {
    const u = await makeUser();
    const create = vi.spyOn(mockProvider, "createAssistant");
    await createAgent(u.id, input);
    expect(create.mock.calls[0][0].instructions).toBe(`Be helpful\n\n${ENGLISH_ONLY_VOICE_RULE}`);
  });

  it("leaves instructions untouched for bilingual voices, in either language", async () => {
    const u = await makeUser();
    const create = vi.spyOn(mockProvider, "createAssistant");
    await createAgent(u.id, { ...input, voice: hua });
    await createAgent(u.id, { ...input, voice: hua, language: "zh", name: "B" });
    expect(create.mock.calls.map((c) => c[0].instructions)).toEqual(["Be helpful", "Be helpful"]);
  });

  it("starts every inbound greeting with the recording notice, once, in the agent's language", async () => {
    const u = await makeUser();
    const create = vi.spyOn(mockProvider, "createAssistant");
    await createAgent(u.id, input);
    await createAgent(u.id, { ...input, voice: hua, language: "zh", greeting: "你好", name: "B" });
    await createAgent(u.id, { ...input, greeting: "This call may be recorded. Hi there", name: "C" });
    expect(create.mock.calls.map((c) => c[0].greeting)).toEqual([
      "This call may be recorded. Hi",
      "本次通话可能会被录音。 你好",
      "This call may be recorded. Hi there", // already says it: not doubled
    ]);
  });
});

describe("agent model", () => {
  it("uses the platform default when none is picked", async () => {
    const u = await makeUser();
    const create = vi.spyOn(mockProvider, "createAssistant");
    const a = await createAgent(u.id, { ...input, model: "" });
    expect(a.model).toBeNull();
    expect(create.mock.calls[0][0].model).toBe(config.telnyx.llmModel);
  });

  it("sends the picked model", async () => {
    const u = await makeUser();
    const create = vi.spyOn(mockProvider, "createAssistant");
    const a = await createAgent(u.id, { ...input, model: "openai/gpt-5.4-mini" });
    expect(a.model).toBe("openai/gpt-5.4-mini");
    expect(create.mock.calls[0][0].model).toBe("openai/gpt-5.4-mini");
  });

  it("rejects models we don't offer", async () => {
    const u = await makeUser();
    await expect(createAgent(u.id, { ...input, model: "openai/gpt-5.6-sol" })).rejects.toThrow(/isn't available/);
  });

  it("asks for another model once the saved one is no longer offered, even if it wasn't changed", async () => {
    const u = await makeUser();
    const a = await createAgent(u.id, { ...input, model: "openai/gpt-5.4-mini" });
    vi.spyOn(mockProvider, "listModels").mockResolvedValue(toOfferedModels(MOCK_MODELS).filter((m) => m.id !== "openai/gpt-5.4-mini"));
    // It may have left the list for its price, which a flat per-minute price can't absorb.
    await expect(updateAgent(u.id, a.id, { ...input, model: "openai/gpt-5.4-mini" })).rejects.toThrow(/isn't available/);
    expect(await updateAgent(u.id, a.id, { ...input, model: "" })).toMatchObject({ model: null, status: "ready" });
  });

  it("says cloned voices are temporarily unavailable when the provider refuses them", async () => {
    const u = await makeUser();
    vi.spyOn(mockProvider, "createAssistant").mockRejectedValue(new FeatureNotPermittedError("cloned_voices", "403"));
    const a = await createAgent(u.id, input);
    expect(a.status).toBe("failed");
    expect(a.failureReason).toBe(errorText("en", "cloningUnavailablePickBuiltIn"));
  });
});

describe("voice cloning switched off", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses new clones without charging", async () => {
    vi.stubEnv("VOICE_CLONING", "off");
    const u = await makeUser(1000);
    const audio = new File([new Uint8Array(5000)], "s.wav", { type: "audio/wav" });
    await expect(cloneVoice(u.id, { name: "Me", language: "en", gender: "female", audio, consent: true })).rejects.toThrow(
      CLONING_UNAVAILABLE,
    );
    expect(await db.select().from(voices)).toHaveLength(0);
  });

  it("refuses cloned voices for agents before contacting the provider", async () => {
    const u = await makeUser(1000);
    const audio = new File([new Uint8Array(5000)], "s.wav", { type: "audio/wav" });
    const clone = await cloneVoice(u.id, { name: "Me", language: "en", gender: "female", audio, consent: true });
    vi.stubEnv("VOICE_CLONING", "off");
    const create = vi.spyOn(mockProvider, "createAssistant");
    await expect(createAgent(u.id, { ...input, voice: `clone:${clone.id}` })).rejects.toThrow(CLONING_UNAVAILABLE);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("agent behavior and variables", () => {
  it("defaults to ending calls when done, the 30-minute limit and a one-minute silence timeout", async () => {
    const u = await makeUser();
    const create = vi.spyOn(mockProvider, "createAssistant");
    await createAgent(u.id, input);
    expect(create.mock.calls[0][0].behavior).toEqual(DEFAULT_BEHAVIOR);
    expect(DEFAULT_BEHAVIOR).toMatchObject({ endCallWhenDone: true, maxCallMinutes: 30, silenceHangupSecs: 60, responseTiming: "quick" });
  });

  it("saves behavior, falling back to defaults for values we don't offer", async () => {
    const u = await makeUser();
    const create = vi.spyOn(mockProvider, "createAssistant");
    await createAgent(u.id, {
      ...input,
      behavior: { voiceSpeed: "1.1", maxCallMinutes: "10", silenceHangupSecs: "45", endCallWhenDone: false, timeZone: "Mars/Olympus" },
    });
    expect(create.mock.calls[0][0].behavior).toMatchObject({ voiceSpeed: 1.1, maxCallMinutes: 10, silenceHangupSecs: 60, endCallWhenDone: false, timeZone: "America/New_York" });
  });

  it("reads agents saved before a setting existed with its default", () => {
    expect(readBehavior({ voiceSpeed: 0.9 })).toEqual({ ...DEFAULT_BEHAVIOR, voiceSpeed: 0.9 });
    expect(readBehavior(null)).toEqual(DEFAULT_BEHAVIOR);
  });

  it("rejects overly long key terms", async () => {
    const u = await makeUser();
    await expect(createAgent(u.id, { ...input, behavior: { keyTerms: "x".repeat(1001) } })).rejects.toThrow(/Key terms are too long/);
  });

  it("sends the agent's variables as defaults", async () => {
    const u = await makeUser();
    const create = vi.spyOn(mockProvider, "createAssistant");
    await createAgent(u.id, {
      ...input,
      variables: [
        { key: "owner_name", value: "Alex" },
        { key: "callback_number", value: "", askPerCall: true },
      ],
    });
    expect(create.mock.calls[0][0].variables).toEqual({ owner_name: "Alex", callback_number: "" });
  });

  it.each([
    [[{ key: "Owner Name", value: "A" }], /can't be a variable name/],
    [[{ key: "call_goal", value: "A" }], /built-in name/],
    [[{ key: "telnyx_x", value: "A" }], /built-in name/],
    [[{ key: "a", value: "1" }, { key: "a", value: "2" }], /two variables named/],
    [[{ key: "owner_name", value: "" }], /Give “owner_name” a value/],
    [[{ key: "", value: "Alex" }], /Give every variable a name/],
    [[{ key: "notes", value: "x".repeat(501) }], /value for “notes” can be at most 500/],
    [Array.from({ length: 11 }, (_, i) => ({ key: `v${i}`, value: "x" })), /at most 10 variables/],
  ])("rejects invalid variables %#", async (variables, error) => {
    const u = await makeUser();
    await expect(createAgent(u.id, { ...input, variables })).rejects.toThrow(error);
  });

  it("finds variables a script uses that nothing fills in", () => {
    expect(
      undefinedVariables(["Hi {{owner_name}}, it's {{ current_time }}", "{{call_goal}} {{telnyx_current_date}} {{ownr_name}}"], [{ key: "owner_name" }]),
    ).toEqual(["ownr_name"]);
  });
});

describe("templates", () => {
  it.each(TEMPLATE_IDS)("%s only uses variables it defines or that are built in", (id) => {
    const tpl = AGENT_TEMPLATES[id];
    expect(undefinedVariables([tpl.greeting, tpl.instructions], tpl.variables)).toEqual([]);
  });

  it.each(TEMPLATE_IDS)("%s has a name and description", (id) => {
    expect(MESSAGES.en.agentTemplates[id]).toEqual({ name: expect.any(String), description: expect.any(String) });
  });

  it("offers front desk, which answers from a knowledge base, only where agents can have one", () => {
    expect(offeredTemplates(true)).toEqual(TEMPLATE_IDS);
    expect(offeredTemplates(false)).toEqual(TEMPLATE_IDS.filter((id) => id !== "frontDesk"));
  });

  it("can be saved once its variables are filled in", async () => {
    const u = await makeUser();
    const tpl = AGENT_TEMPLATES.booking;
    const variables = tpl.variables.map((v) => ({ ...v, value: v.askPerCall ? "" : "Alex" }));
    const a = await createAgent(u.id, { ...input, greeting: tpl.greeting, instructions: tpl.instructions, behavior: tpl.behavior, variables });
    expect(a.status).toBe("ready");
  });
});
