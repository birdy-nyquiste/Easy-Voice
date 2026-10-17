import type { Language } from "@/lib/language";
import type { PreviewAudio } from "../telnyx";

/**
 * The parts of ElevenLabs we call directly with a user's own key: checking the key, cloning
 * and deleting voices, and previews. Calls never go through here; Telnyx speaks with the voice
 * itself using the same key (voice_settings.api_key_ref).
 */
export interface ElevenLabsClient {
  readonly name: string;
  /** Max accepted sample size in bytes. */
  readonly maxCloneSampleBytes: number;
  /** Throws ElevenLabsError (status 401) when the key is invalid or lacks a permission we need. */
  getAccount(apiKey: string): Promise<ElevenLabsAccount>;
  /** Instant Voice Cloning; the voice is usable as soon as this returns. */
  cloneVoice(
    apiKey: string,
    input: { name: string; language: Language; gender: "male" | "female"; audio: Blob },
  ): Promise<{ voiceId: string; requiresVerification: boolean }>;
  /** Succeeds if the voice is already gone. */
  deleteVoice(apiKey: string, voiceId: string): Promise<void>;
  synthesize(apiKey: string, voiceId: string, text: string): Promise<PreviewAudio>;
}

export interface ElevenLabsAccount {
  /** Stable id of the ElevenLabs account the key belongs to. */
  accountId: string;
  /** Plan name, e.g. "starter". */
  tier: string;
  /** False on plans without Instant Voice Cloning (Free). */
  canClone: boolean;
}

export class ElevenLabsError extends Error {
  name = "ElevenLabsError";
  constructor(
    public status: number,
    /** ElevenLabs `detail.status`, e.g. "invalid_api_key", "missing_permissions", "voice_limit_reached". */
    public code: string,
    /** ElevenLabs' own explanation, safe to show to the key's owner. */
    public detail: string,
  ) {
    super(`ElevenLabs ${status} ${code}: ${detail}`);
  }
}
