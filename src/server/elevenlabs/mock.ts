import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ElevenLabsError, type ElevenLabsClient } from "./types";

/**
 * In-process ElevenLabs for dev and tests. Keys containing "invalid" are rejected, "free"
 * keys can't clone, and the account id is derived from the key's "acct_<letters>" part if present,
 * so tests can tell two accounts apart.
 */

const g = globalThis as unknown as { __mockElevenLabs?: { voices: Map<string, { apiKey: string }> } };
const state = (g.__mockElevenLabs ??= { voices: new Map() });

function check(apiKey: string) {
  if (!apiKey || apiKey.includes("invalid")) throw new ElevenLabsError(401, "invalid_api_key", "Invalid API key");
}

export const mockElevenLabs: ElevenLabsClient = {
  name: "mock",
  maxCloneSampleBytes: 10 * 1024 * 1024,

  async getAccount(apiKey) {
    check(apiKey);
    const acct = /acct_([a-z]+)/.exec(apiKey)?.[1] ?? "mock-account";
    const free = apiKey.includes("free");
    return { accountId: acct, tier: free ? "free" : "starter", canClone: !free };
  },

  async checkKey(apiKey) {
    check(apiKey);
  },

  async cloneVoice(apiKey, { audio }) {
    check(apiKey);
    if (audio.size < 1000) throw new ElevenLabsError(400, "invalid_audio", "The audio sample is too short.");
    const voiceId = `elvoice${randomUUID().replaceAll("-", "").slice(0, 13)}`;
    state.voices.set(voiceId, { apiKey });
    return { voiceId, requiresVerification: false };
  },

  async deleteVoice(apiKey, voiceId) {
    check(apiKey);
    state.voices.delete(voiceId);
  },

  async synthesize(apiKey, voiceId) {
    check(apiKey);
    if (!state.voices.has(voiceId)) throw new ElevenLabsError(404, "voice_not_found", "A voice with that ID was not found.");
    const buf = await readFile(path.join(process.cwd(), "public/mock-recording.wav"));
    return { audio: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, contentType: "audio/wav" };
  },
};
