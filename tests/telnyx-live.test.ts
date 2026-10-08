import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelnyxProvider } from "@/server/telnyx/live";
import { MOCK_MODELS, toOfferedModels } from "@/server/telnyx/models";
import { FeatureNotPermittedError } from "@/server/telnyx/types";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

const provider = createTelnyxProvider({
  mode: "live",
  apiKey: "test",
  publicKey: rawPub,
  connectionId: "conn",
  llmModel: "moonshotai/Kimi-K2.6",
  sttModel: "assemblyai/universal-3-5-pro",
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

  it("offers English Kokoro and bilingual Mandarin Ultra voices (bilingual first), skipping deprecated and other models", () => {
    const voices = toStockVoices([
      { id: "Telnyx.KokoroTTS.af_heart", name: "af_heart", language: "en-US", model_id: "KokoroTTS", gender: "Female" },
      { id: "Telnyx.Ultra.aaa", name: "Hao - Friendly Guy", language: "zh", model_id: "Ultra", gender: "Male" },
      { id: "Telnyx.Ultra.bbb", name: "Old", language: "zh", model_id: "Ultra", deprecated: true },
      { id: "Telnyx.Ultra.ccc", name: "Asher", language: "en-US", model_id: "Ultra" },
      { id: "Telnyx.Bayan.ASSY", name: "ASSY", language: "ar-JO", model_id: "Bayan" },
    ]);
    expect(voices).toEqual([
      { ref: "Telnyx.Ultra.aaa", name: "Hao - Friendly Guy", language: "zh-CN", speaks: ["zh", "en"], gender: "male", provider: "Telnyx" },
      { ref: "Telnyx.KokoroTTS.af_heart", name: "Heart", language: "en-US", speaks: ["en"], gender: "female", provider: "Telnyx" },
    ]);
  });
});

describe("number search", () => {
  afterEach(() => vi.unstubAllGlobals());

  function respond(status: number, body: unknown) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  }

  it("treats Telnyx 10031 (no matches) as an empty result", async () => {
    respond(400, { errors: [{ code: "10031", title: "Invalid request filter" }] });
    await expect(provider.searchNumbers({ areaCode: "999" })).resolves.toEqual([]);
  });

  it("asks for best-effort results and lists exact matches before nearby ones", async () => {
    respond(200, {
      data: [
        { phone_number: "+16285550001", best_effort: true, region_information: [{ region_type: "state", region_name: "CA" }] },
        { phone_number: "+14155550001", best_effort: false, region_information: [{ region_type: "rate_center", region_name: "SAN FRANCISCO" }] },
      ],
    });
    const res = await provider.searchNumbers({ areaCode: "415" });
    expect(res.map((n) => [n.e164, n.nearby])).toEqual([["+14155550001", false], ["+16285550001", true]]);
    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(decodeURIComponent(url)).toContain("filter[best_effort]=true");
  });

  it("still surfaces other API errors", async () => {
    respond(401, { errors: [{ code: "10009", title: "Authentication failed" }] });
    await expect(provider.searchNumbers({ areaCode: "415" })).rejects.toThrow(/401/);
  });
});

describe("call results", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pages through conversation messages at Telnyx's 100-per-page limit", async () => {
    const msg = (i: number) => ({ role: i % 2 ? "user" : "assistant", text: `m${i}`, sent_at: `2026-10-07T10:00:${String(i).padStart(2, "0")}Z` });
    const fetchMock = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page[number]"));
      const data = page === 1 ? [msg(2), msg(1)] : [msg(3)];
      return new Response(JSON.stringify({ data, meta: { total_pages: 2 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await provider.getCallResults({ callControlId: "cc", conversationId: "conv-1" });
    expect(res?.transcript.map((m) => m.text)).toEqual(["m1", "m2", "m3"]);
    for (const [url] of fetchMock.mock.calls) expect(new URL(url).searchParams.get("page[size]")).toBe("100");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("assistant config", () => {
  afterEach(() => vi.unstubAllGlobals());

  const spec = { name: "A", instructions: "i", greeting: "g", language: "en", voiceRef: "Telnyx.KokoroTTS.af_heart", model: "openai/gpt-5.4-mini" } as const;

  it("turns off the assistant's own recording so each call is recorded once", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "assistant-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await provider.createAssistant(spec);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.telephony_settings).toEqual({ recording_settings: { enabled: false } });
    expect(body.dynamic_variables).toEqual({ call_direction: "inbound", call_goal: "" });
    expect(body.model).toBe("openai/gpt-5.4-mini");
  });

  it("reports Telnyx's cloned-voice restriction as FeatureNotPermittedError", async () => {
    const detail = "Your account is not permitted to use cloned voices. Please complete L2 verification or use a platform voice.";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: "10010", detail }] }), { status: 403 })));
    await expect(provider.createAssistant(spec)).rejects.toBeInstanceOf(FeatureNotPermittedError);
  });
});

describe("LLM catalog", () => {
  it("offers recommended, priced models up to the output price cap", () => {
    expect(toOfferedModels(MOCK_MODELS).map((m) => m.id)).toEqual([
      "anthropic/claude-haiku-4-5",
      "zai-org/GLM-5.3-Flash",
      "openai/gpt-5.4-mini",
      "moonshotai/Kimi-K2.6",
    ]);
  });
});

describe("voice previews", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("synthesizes with the catalog voice and returns the audio", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await provider.synthesizePreview("Telnyx.KokoroTTS.af_heart", "Hello");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/text-to-speech\/speech$/);
    expect(JSON.parse(String(init.body))).toEqual({ text: "Hello", voice: "Telnyx.KokoroTTS.af_heart" });
    expect(res.contentType).toBe("audio/mpeg");
    expect(res.audio.byteLength).toBe(3);
  });

  it("fetches a clone's sample with Accept: */* (Telnyx answers 406 to audio/*)", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/wav; charset=utf-8" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await provider.getCloneSample("clone-1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/voice_clones\/clone-1\/sample$/);
    expect((init.headers as Record<string, string>).Accept).toBe("*/*");
    expect(res.contentType).toBe("audio/wav");
  });
});

describe("per-call variables", () => {
  afterEach(() => vi.unstubAllGlobals());
  const bodyOf = (m: ReturnType<typeof vi.fn>, i = 0) =>
    JSON.parse(String((m.mock.calls[i] as unknown as [string, RequestInit])[1].body));

  it("answer sends dynamic variables but keeps the stored voice and greeting", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { result: "ok" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await provider.answer("cc", "call-1", {
      assistantId: "assistant-1",
      voiceRef: "Telnyx.KokoroTTS.af_heart",
      variables: { call_direction: "inbound", call_goal: "" },
    });
    const body = bodyOf(fetchMock);
    expect(body.assistant).toEqual({ id: "assistant-1", dynamic_variables: { call_direction: "inbound", call_goal: "" } });
    expect(body.greeting).toBeUndefined();
  });

  it("ai_assistant_start sends the goal and the outbound greeting", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { conversation_id: "conv-9" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await provider.startAssistant("cc", {
      assistantId: "assistant-1",
      voiceRef: "x",
      variables: { call_direction: "outbound", call_goal: "Book a table for 2" },
      greetingOverride: "Hi, this is an AI assistant calling.",
    });
    expect(res.conversationId).toBe("conv-9");
    const body = bodyOf(fetchMock);
    expect(body.assistant.dynamic_variables).toEqual({ call_direction: "outbound", call_goal: "Book a table for 2" });
    expect(body.greeting).toBe("Hi, this is an AI assistant calling.");
  });
});
