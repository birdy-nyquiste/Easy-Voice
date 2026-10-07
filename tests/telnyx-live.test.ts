import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTelnyxProvider } from "@/server/telnyx/live";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

const provider = createTelnyxProvider({
  mode: "live",
  apiKey: "test",
  publicKey: rawPub,
  connectionId: "conn",
  llmModel: "",
  sttModel: "deepgram/nova-3",
  sttLanguage: "auto",
  cloneModel: "Qwen3TTS",
  insightGroupId: "",
});

const body = JSON.stringify({
  data: {
    id: "evt-1",
    event_type: "call.initiated",
    occurred_at: "2026-10-07T10:00:00Z",
    payload: { call_control_id: "cc", direction: "incoming", from: "+1202", to: "+1415", client_state: Buffer.from("abc").toString("base64") },
  },
});

function headers(ts: number, payload = body) {
  const sig = sign(null, Buffer.from(`${ts}|${payload}`), privateKey).toString("base64");
  return new Headers({ "telnyx-signature-ed25519": sig, "telnyx-timestamp": String(ts) });
}

describe("Telnyx webhook verification", () => {
  const now = Math.floor(Date.now() / 1000);

  it("accepts a valid signature and normalizes the event", async () => {
    const e = await provider.parseWebhook(body, headers(now));
    expect(e).toMatchObject({ id: "evt-1", type: "call.initiated", direction: "inbound", clientState: "abc", callControlId: "cc" });
  });

  it("rejects a tampered body", async () => {
    await expect(provider.parseWebhook(body.replace("+1415", "+1999"), headers(now))).rejects.toThrow(/signature/);
  });

  it("rejects stale timestamps", async () => {
    await expect(provider.parseWebhook(body, headers(now - 600))).rejects.toThrow(/Stale/);
  });
});

describe("stock voice catalog", async () => {
  const { toStockVoices } = await import("@/server/telnyx/stock-voices");

  it("offers English Kokoro and Mandarin Ultra voices, skipping deprecated and other models", () => {
    const voices = toStockVoices([
      { id: "Telnyx.KokoroTTS.af_heart", name: "af_heart", language: "en-US", model_id: "KokoroTTS", gender: "Female" },
      { id: "Telnyx.Ultra.aaa", name: "Hao - Friendly Guy", language: "zh", model_id: "Ultra", gender: "Male" },
      { id: "Telnyx.Ultra.bbb", name: "Old", language: "zh", model_id: "Ultra", deprecated: true },
      { id: "Telnyx.Ultra.ccc", name: "Asher", language: "en-US", model_id: "Ultra" },
      { id: "Telnyx.Bayan.ASSY", name: "ASSY", language: "ar-JO", model_id: "Bayan" },
    ]);
    expect(voices).toEqual([
      { ref: "Telnyx.KokoroTTS.af_heart", name: "Heart", language: "en-US", gender: "female", provider: "Telnyx" },
      { ref: "Telnyx.Ultra.aaa", name: "Hao - Friendly Guy", language: "zh-CN", gender: "male", provider: "Telnyx" },
    ]);
  });
});
