import { config } from "@/lib/config";
import { mockProvider } from "./mock";
import type { VoiceProvider } from "./types";

let live: VoiceProvider | undefined;

export function voiceProvider(): VoiceProvider {
  if (config.telnyx.mode !== "live") return mockProvider;
  if (!live) {
    // Lazy so mock-mode never needs live credentials.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    live = (require("./live") as typeof import("./live")).createTelnyxProvider(config.telnyx);
  }
  return live;
}

export type * from "./types";
export { FeatureNotPermittedError } from "./types";
