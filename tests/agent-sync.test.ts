import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { config } from "@/lib/config";
import { createAgent, platformFingerprint, resyncStaleAgents } from "@/server/agents";
import { mockProvider } from "@/server/telnyx/mock";
import { makeUser, resetDb } from "./helpers";

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

  it("can scope the re-sync to one user", async () => {
    const [u1, u2] = [await makeUser(), await makeUser()];
    await createAgent(u1.id, input);
    await createAgent(u2.id, input);
    config.telnyx.sttLanguage = "zh";
    expect(await resyncStaleAgents(u1.id)).toBe(1);
    expect(await resyncStaleAgents()).toBe(1);
  });
});
