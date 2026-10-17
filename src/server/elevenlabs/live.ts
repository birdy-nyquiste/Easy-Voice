import { config } from "@/lib/config";
import { ElevenLabsError, type ElevenLabsClient } from "./types";

/** ElevenLabs REST adapter. See docs/elevenlabs-notes.md. Auth is the user's key in `xi-api-key`. */

const BASE = "https://api.elevenlabs.io";

async function request(apiKey: string, method: string, path: string, body?: FormData | object): Promise<Response> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "xi-api-key": apiKey, ...(body && !isForm ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res, path);
  return res;
}

/** Errors come as `{ detail: { status, message } }`, or `{ detail: [...] }` for validation errors. */
async function toError(res: Response, path: string): Promise<ElevenLabsError> {
  const text = await res.text();
  let code = "error";
  let detail = text.slice(0, 300) || res.statusText;
  try {
    const d = (JSON.parse(text) as { detail?: unknown }).detail;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      const o = d as { status?: string; message?: string };
      code = o.status ?? code;
      detail = o.message ?? detail;
    } else if (typeof d === "string") {
      detail = d;
    }
  } catch {
    // not JSON; keep the raw text
  }
  console.error(`ElevenLabs ${res.status} on ${path}: ${text.slice(0, 500)}`);
  return new ElevenLabsError(res.status, code, detail);
}

export const liveElevenLabs: ElevenLabsClient = {
  name: "elevenlabs",
  // ElevenLabs accepts larger files; our upload limit (config.limits.cloneSampleBytes) is lower anyway.
  maxCloneSampleBytes: 10 * 1024 * 1024,

  async getAccount(apiKey) {
    const user = (await (await request(apiKey, "GET", "/v1/user")).json()) as { user_id: string };
    const sub = (await (await request(apiKey, "GET", "/v1/user/subscription")).json()) as {
      tier?: string;
      can_use_instant_voice_cloning?: boolean;
    };
    return { accountId: user.user_id, tier: sub.tier ?? "unknown", canClone: sub.can_use_instant_voice_cloning !== false };
  },

  async cloneVoice(apiKey, { name, language, gender, audio }) {
    const form = new FormData();
    form.set("name", name);
    form.append("files", audio, audio instanceof File ? audio.name : "sample.wav");
    form.set("remove_background_noise", "true");
    form.set("description", "Cloned in Easy Voice");
    form.set("labels", JSON.stringify({ language, gender }));
    const res = (await (await request(apiKey, "POST", "/v1/voices/add", form)).json()) as {
      voice_id: string;
      requires_verification?: boolean;
    };
    return { voiceId: res.voice_id, requiresVerification: Boolean(res.requires_verification) };
  },

  async deleteVoice(apiKey, voiceId) {
    try {
      await request(apiKey, "DELETE", `/v1/voices/${encodeURIComponent(voiceId)}`);
    } catch (err) {
      if (!(err instanceof ElevenLabsError && (err.status === 404 || err.code === "voice_not_found"))) throw err;
    }
  },

  async synthesize(apiKey, voiceId, text) {
    const res = await request(apiKey, "POST", `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      text,
      model_id: config.elevenlabs.ttsModel,
    });
    return { audio: await res.arrayBuffer(), contentType: res.headers.get("content-type")?.split(";")[0] || "audio/mpeg" };
  },
};
