import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { agents, voices } from "@/db/schema";
import { MESSAGES } from "@/i18n/messages";
import { DEFAULT_BEHAVIOR, readBehavior, undefinedVariables } from "@/lib/agent-settings";
import { AGENT_TEMPLATES, TEMPLATE_IDS } from "@/lib/agent-templates";
import { config } from "@/lib/config";
import { errorText } from "@/lib/errors";
import { createAgent, ENGLISH_ONLY_VOICE_RULE, platformFingerprint, resyncStaleAgents } from "@/server/agents";
import { mockProvider } from "@/server/telnyx/mock";
import { FeatureNotPermittedError } from "@/server/telnyx/types";
import { cloneVoice } from "@/server/voices";
import { makeUser, resetDb } from "./helpers";

const CLONING_UNAVAILABLE = errorText("en", "cloningUnavailable");

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

  it("can be saved once its variables are filled in", async () => {
    const u = await makeUser();
    const tpl = AGENT_TEMPLATES.booking;
    const variables = tpl.variables.map((v) => ({ ...v, value: v.askPerCall ? "" : "Alex" }));
    const a = await createAgent(u.id, { ...input, greeting: tpl.greeting, instructions: tpl.instructions, behavior: tpl.behavior, variables });
    expect(a.status).toBe("ready");
  });
});
