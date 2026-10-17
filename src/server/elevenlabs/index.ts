import { config } from "@/lib/config";
import { mockElevenLabs } from "./mock";
import type { ElevenLabsClient } from "./types";

export function elevenLabs(): ElevenLabsClient {
  if (config.elevenlabs.mode !== "live") return mockElevenLabs;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("./live") as typeof import("./live")).liveElevenLabs;
}

export type * from "./types";
export { ElevenLabsError } from "./types";
