import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BEHAVIOR } from "@/lib/agent-settings";
import { createTelnyxProvider, HANGUP_TOOL_DESCRIPTION } from "@/server/telnyx/live";
import { MOCK_MODELS, toOfferedModels } from "@/server/telnyx/models";
import { MOCK_CATALOG } from "@/server/telnyx/stock-voices";
import { FeatureNotPermittedError } from "@/server/telnyx/types";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

const telnyxConfig: Parameters<typeof createTelnyxProvider>[0] = {
  mode: "live",
  apiKey: "test",
  publicKey: rawPub,
  connectionId: "conn",
  llmModel: "moonshotai/Kimi-K2.6",
  sttModel: "assemblyai/universal-3-5-pro",
  sttLanguage: "auto",
  cloneModel: "Qwen3TTS",
  insightGroupId: "",
  messagingProfileId: "mp-1",
};
const provider = createTelnyxProvider(telnyxConfig);

const callId = "7d1f3c2a-9b4e-4f6a-8c1d-2e3f4a5b6c7d";
const body = JSON.stringify({
  data: {
    id: "evt-1",
    event_type: "call.initiated",
    occurred_at: "2026-10-07T10:00:00Z",
    payload: { call_control_id: "cc", direction: "incoming", from: "+1202", to: "+1415", client_state: Buffer.from(callId).toString("base64") },
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
    expect(e).toMatchObject({ id: "evt-1", type: "call.initiated", direction: "inbound", clientState: callId, callControlId: "cc" });
  });

  it("drops a client_state that isn't one of our call ids", async () => {
    const foreign = body.replace(Buffer.from(callId).toString("base64"), Buffer.from("abc").toString("base64"));
    expect(await provider.parseWebhook(foreign, headers(now, foreign))).toMatchObject({ callControlId: "cc", clientState: undefined });
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

  it("asks for numbers that can receive texts too, when texting is set up", async () => {
    const features = (url: string) => new URL(url).searchParams.getAll("filter[features][]");
    respond(200, { data: [] });
    await provider.searchNumbers({ areaCode: "415" });
    expect(features(String(vi.mocked(fetch).mock.calls[0][0]))).toEqual(["voice", "sms"]);

    respond(200, { data: [] });
    await createTelnyxProvider({ ...telnyxConfig, messagingProfileId: "" }).searchNumbers({ areaCode: "415" });
    expect(features(String(vi.mocked(fetch).mock.calls[0][0]))).toEqual(["voice"]);
  });
});

describe("catalogs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const down =() => vi.fn(async () => new Response("unavailable", { status: 503 }));
  const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

  it.each([
    ["voices", (p: ReturnType<typeof createTelnyxProvider>) => p.listStockVoices(), { voices: MOCK_CATALOG }],
    ["models", (p: ReturnType<typeof createTelnyxProvider>) => p.listModels(), { data: MOCK_MODELS }],
  ] as const)("keeps serving the last %s when a refresh fails, and fails only without any", async (_, list, body) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const live = createTelnyxProvider(telnyxConfig);
    vi.stubGlobal("fetch", down());
    await expect(list(live)).rejects.toThrow(/503/);

    vi.stubGlobal("fetch", ok(body));
    const first = await list(live);
    expect(first.length).toBeGreaterThan(0);

    // Past the hour the catalog is cached for.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60 * 60 * 1000 });
    const failing = down();
    vi.stubGlobal("fetch", failing);
    await expect(list(live)).resolves.toEqual(first);
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

describe("numbers and deletes", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Answer each request by method and path. */
  function route(handlers: Record<string, [number, unknown]>) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.replace(/^\/v2/, "");
      const [status, body] = handlers[`${init?.method ?? "GET"} ${path}`] ?? [500, { errors: [{ detail: "unexpected" }] }];
      return new Response(JSON.stringify(body), { status });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("treats a number that is already gone as released", async () => {
    route({ "DELETE /phone_numbers/num_1": [404, { errors: [{ code: "10005" }] }] });
    await expect(provider.releaseNumber("num_1")).resolves.toBeUndefined();
  });

  it("treats an assistant that is already gone as deleted", async () => {
    route({ "DELETE /ai/assistants/assistant-1": [404, { errors: [{ code: "10005" }] }] });
    await expect(provider.deleteAssistant("assistant-1")).resolves.toBeUndefined();
  });

  it("finishes a purge whose recording or conversation is already gone", async () => {
    route({
      "GET /recordings": [200, { data: [{ id: "rec_1" }] }],
      "DELETE /recordings/rec_1": [404, {}],
      "DELETE /ai/conversations/conv_1": [404, {}],
    });
    await expect(provider.purgeCallData({ callControlId: "cc", callSessionId: "sess", conversationId: "conv_1" })).resolves.toBeUndefined();
  });

  it("reports a completed order as pending until the number's id can be looked up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    route({
      "POST /number_orders": [200, { data: { id: "ord_1", status: "success", phone_numbers: [{ phone_number: "+14155551234", status: "success" }] } }],
      "GET /phone_numbers": [503, {}],
    });
    expect(await provider.orderNumber("+14155551234")).toMatchObject({ orderId: "ord_1", status: "pending", numberId: undefined });
    route({
      "POST /number_orders": [200, { data: { id: "ord_1", status: "success", phone_numbers: [{ phone_number: "+14155551234", status: "success" }] } }],
      "GET /phone_numbers": [200, { data: [{ id: "num_9" }] }],
    });
    expect(await provider.orderNumber("+14155551234")).toMatchObject({ status: "success", numberId: "num_9" });
  });

  it("gives every request a timeout", async () => {
    const fetchMock = route({ "DELETE /phone_numbers/num_1": [200, {}] });
    await provider.releaseNumber("num_1");
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
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

  it("returns the transcript while the summary is still being generated", async () => {
    const withInsights = createTelnyxProvider({ ...telnyxConfig, insightGroupId: "ig-1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const data = url.includes("conversations-insights") ? [{ status: "in_progress" }] : [{ role: "user", text: "Hi" }];
        return new Response(JSON.stringify({ data }), { status: 200 });
      }),
    );
    expect(await withInsights.getCallResults({ callControlId: "cc", conversationId: "conv-1" })).toEqual({
      transcript: [{ role: "user", text: "Hi" }],
      summary: undefined,
      summaryPending: true,
    });
  });
});

describe("assistant config", () => {
  afterEach(() => vi.unstubAllGlobals());

  const spec = {
    name: "A",
    instructions: "i",
    greeting: "g",
    language: "en",
    voiceRef: "Telnyx.KokoroTTS.af_heart",
    model: "openai/gpt-5.4-mini",
    behavior: DEFAULT_BEHAVIOR,
    variables: {},
  } as const;
  const hangup = { type: "hangup", hangup: { description: HANGUP_TOOL_DESCRIPTION } };
  const sentBodies = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)));

  it("turns off the assistant's own recording so each call is recorded once", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "assistant-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await provider.createAssistant(spec);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.telephony_settings.recording_settings).toEqual({ enabled: false });
    expect(body.dynamic_variables).toEqual({ call_direction: "inbound", call_goal: "", contact_number: "", current_time: "" });
    expect(body.model).toBe("openai/gpt-5.4-mini");
  });

  it("references the user's ElevenLabs key secret for ElevenLabs voices only", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "assistant-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await provider.createAssistant({ ...spec, voiceRef: "ElevenLabs.eleven_flash_v2_5.v1", voiceApiKeyRef: "elevenlabs_u_1" });
    await provider.createAssistant(spec);
    const sent = fetchMock.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).voice_settings);
    const silence = { type: "predefined_media", value: "silence", volume: 0.5 };
    expect(sent).toEqual([
      { voice: "ElevenLabs.eleven_flash_v2_5.v1", api_key_ref: "elevenlabs_u_1", speed: 1, background_audio: silence },
      { voice: "Telnyx.KokoroTTS.af_heart", voice_speed: 1, background_audio: silence },
    ]);
  });

  it("always sends the full tool list: hangup when the agent ends calls, retrieval for a knowledge bucket", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "assistant-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const noHangup = { ...DEFAULT_BEHAVIOR, endCallWhenDone: false };
    await provider.createAssistant({ ...spec, knowledgeBucket: "ev-kb-abc" });
    await provider.updateAssistant("assistant-1", spec);
    await provider.updateAssistant("assistant-1", { ...spec, behavior: noHangup });
    const retrieval = { type: "retrieval", retrieval: { bucket_ids: ["ev-kb-abc"], max_num_results: 3 } };
    expect(sentBodies(fetchMock).map((b) => b.tools)).toEqual([[hangup, retrieval], [hangup], []]);
  });

  it("maps the agent's behavior and variables to assistant settings", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "assistant-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const behavior = {
      ...DEFAULT_BEHAVIOR,
      voiceSpeed: 1.15,
      backgroundSound: "office",
      responseTiming: "patient",
      allowInterruptions: false,
      greetingInterruptible: false,
      keyTerms: "Nyquiste, Okafor",
      maxCallMinutes: 10,
      silenceHangupSecs: 0,
    } as const;
    await provider.createAssistant({ ...spec, behavior, variables: { owner_name: "Alex" } });
    await provider.updateAssistant("assistant-1", spec);
    const [custom, defaults] = sentBodies(fetchMock);
    expect(custom.voice_settings).toMatchObject({ voice_speed: 1.15, background_audio: { value: "office" } });
    expect(custom.transcription.settings).toEqual({ keyterm: "Nyquiste, Okafor" });
    expect(custom.interruption_settings).toEqual({ enable: false, disable_greeting_interruption: true, start_speaking_plan: { wait_seconds: 1.2 } });
    expect(custom.telephony_settings).toEqual({ time_limit_secs: 600, user_idle_timeout_secs: null, recording_settings: { enabled: false } });
    expect(custom.dynamic_variables.owner_name).toBe("Alex");
    // Defaults: Telnyx's own turn-taking, 30-minute limit, hang up after a minute of silence, no key terms.
    expect(defaults.transcription.settings).toEqual({ keyterm: null });
    expect(defaults.interruption_settings).toEqual({ enable: true, disable_greeting_interruption: false, start_speaking_plan: { wait_seconds: 0.4 } });
    expect(defaults.telephony_settings).toEqual({ time_limit_secs: 1800, user_idle_timeout_secs: 60, recording_settings: { enabled: false } });
  });

  it("stores integration secrets as bearer tokens", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { id: "sec-1", identifier: "elevenlabs_u_1" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await provider.createIntegrationSecret("elevenlabs_u_1", "sk_x")).toEqual({ id: "sec-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/integration_secrets$/);
    expect(JSON.parse(String(init.body))).toEqual({ identifier: "elevenlabs_u_1", type: "bearer", token: "sk_x" });
  });

  it("reports Telnyx's cloned-voice restriction as FeatureNotPermittedError", async () => {
    const detail = "Your account is not permitted to use cloned voices. Please complete L2 verification or use a platform voice.";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: "10010", detail }] }), { status: 403 })));
    await expect(provider.createAssistant(spec)).rejects.toBeInstanceOf(FeatureNotPermittedError);
  });
});

describe("LLM catalog", () => {
  it("offers recommended, priced models up to the output price cap, except ones that need our own key", () => {
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
      variables: { call_direction: "inbound", call_goal: "", contact_number: "+14155550100", current_time: "now" },
    });
    const body = bodyOf(fetchMock);
    expect(body.assistant).toEqual({
      id: "assistant-1",
      dynamic_variables: { call_direction: "inbound", call_goal: "", contact_number: "+14155550100", current_time: "now" },
    });
    expect(body.greeting).toBeUndefined();
  });

  it("ai_assistant_start sends the goal and the outbound greeting", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { conversation_id: "conv-9" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await provider.startAssistant("cc", {
      assistantId: "assistant-1",
      variables: { call_direction: "outbound", call_goal: "Book a table for 2", contact_number: "+14155550100", current_time: "now" },
      greetingOverride: "Hi, this is an AI assistant calling.",
    });
    expect(res.conversationId).toBe("conv-9");
    const body = bodyOf(fetchMock);
    expect(body.assistant.dynamic_variables).toMatchObject({ call_direction: "outbound", call_goal: "Book a table for 2" });
    expect(body.greeting).toBe("Hi, this is an AI assistant calling.");
  });
});

describe("inbound messaging", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("assigns the number to the platform messaging profile", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await provider.enableInboundMessaging("+14155550100");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/messaging_phone_numbers/%2B14155550100");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ messaging_profile_id: "mp-1" });
  });

  it("verifies and parses signed message.received webhooks", async () => {
    const payload = JSON.stringify({
      data: {
        id: "evt-m",
        event_type: "message.received",
        payload: { id: "msg", direction: "inbound", from: { phone_number: "+1202" }, to: [{ phone_number: "+1415" }], text: "hi", parts: 1 },
      },
    });
    const e = await provider.parseWebhook(payload, headers(Math.floor(Date.now() / 1000), payload));
    expect(e).toMatchObject({ type: "message.received", messageId: "msg", from: "+1202", to: "+1415", text: "hi" });
  });
});

describe("knowledge storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("talks S3 to the regional storage host with the API key as the SigV4 access key", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await provider.putObject("ev-kb-abc", "src/s1.txt", new Blob(["hi"], { type: "text/plain" }), "text/plain");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://us-central-1.telnyxcloudstorage.com/ev-kb-abc/src/s1.txt");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=test\/\d{8}\/us-central-1\/s3\/aws4_request, /);
  });

  it("treats a bucket we already own as created, and a missing object as deleted", async () => {
    const owned = "<Error><Code>BucketAlreadyOwnedByYou</Code></Error>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(owned, { status: 409 })));
    await expect(provider.createBucket("ev-kb-abc")).resolves.toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })));
    await expect(provider.deleteObject("ev-kb-abc", "src/gone.txt")).resolves.toBeUndefined();
  });

  it("reads a blank per-file status as embedded, and a missing bucket as nothing yet", async () => {
    const files = [{ filename: "src/a.txt", status: "" }, { filename: "src/b.txt", status: "processing" }, { filename: "src/c.pdf", status: "failed" }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: files }), { status: 200 })));
    expect(Object.fromEntries(await provider.embeddingStatuses("ev-kb-abc"))).toEqual({ "src/a.txt": "ready", "src/b.txt": "processing", "src/c.pdf": "failed" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect((await provider.embeddingStatuses("ev-kb-abc")).size).toBe(0);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 })));
    expect(await provider.listObjects("ev-kb-abc")).toEqual([]);
  });

  it("lists objects across pages, with when each was last written", async () => {
    const at = "2026-10-21T21:05:12.000Z";
    const page = (keys: string[], next?: string) =>
      `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key><LastModified>${at}</LastModified><Size>10</Size></Contents>`).join("")}` +
      `<IsTruncated>${next ? "true" : "false"}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`;
    const fetchMock = vi.fn(async (url: string) => new Response(url.includes("continuation-token") ? page(["depth-4-1.txt"]) : page(["src/a.txt", "depth-4-0.txt"], "t2")));
    vi.stubGlobal("fetch", fetchMock);
    expect(await provider.listObjects("ev-kb-abc")).toEqual([
      { key: "src/a.txt", sizeBytes: 10, modifiedAt: new Date(at) },
      { key: "depth-4-0.txt", sizeBytes: 10, modifiedAt: new Date(at) },
      { key: "depth-4-1.txt", sizeBytes: 10, modifiedAt: new Date(at) },
    ]);
  });
});
