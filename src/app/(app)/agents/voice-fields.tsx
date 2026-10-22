"use client";

import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { Field, inputClass } from "@/components/ui";
import { PreviewButton } from "@/components/voice-preview";
import { VOICE_SPEED, type AgentBehavior } from "@/lib/agent-settings";
import { ModelRow } from "./model-row";

/** The agent's voice picker (with preview), its speech model, and how it sounds on calls. */
export function VoiceFields({
  defaultVoice,
  voiceGone = false,
  voiceOptions,
  ttsByVoice,
  behavior,
}: {
  defaultVoice: string;
  /** The agent's saved voice is no longer offered; one must be picked before saving. */
  voiceGone?: boolean;
  voiceOptions: ReactNode;
  /** Voice picker value → display name of its speech model. */
  ttsByVoice: Record<string, string>;
  behavior: Pick<AgentBehavior, "voiceSpeed" | "backgroundSound">;
}) {
  const t = useTranslations("agents");
  const [voice, setVoice] = useState(defaultVoice);
  const [speed, setSpeed] = useState(behavior.voiceSpeed);
  return (
    <>
      <Field label={t("voice")} hint={t("voiceHint")}>
        <div className="flex gap-2">
          <select name="voice" required value={voice} onChange={(e) => setVoice(e.target.value)} className={inputClass}>
            {voiceOptions}
          </select>
          <PreviewButton voice={voice} />
        </div>
        {voiceGone && !voice && <p className="mt-1 text-sm text-red-600">{t("voiceGone")}</p>}
      </Field>
      <ModelRow label={t("tts")}>
        <span className="font-medium">{ttsByVoice[voice] ?? "—"}</span>
        <span className="text-stone-500">{t("setByVoice")}</span>
      </ModelRow>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("voiceSpeed")} hint={t("voiceSpeedHint")}>
          <div className="flex items-center gap-3">
            <input
              type="range"
              name="voiceSpeed"
              min={VOICE_SPEED.min}
              max={VOICE_SPEED.max}
              step={VOICE_SPEED.step}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="w-full accent-stone-900"
            />
            <span className="w-12 shrink-0 text-right text-sm tabular-nums text-stone-700">{t("speedValue", { speed: speed.toFixed(2) })}</span>
          </div>
        </Field>
        <Field label={t("backgroundSound")}>
          <select name="backgroundSound" defaultValue={behavior.backgroundSound} className={inputClass}>
            <option value="none">{t("backgroundNone")}</option>
            <option value="office">{t("backgroundOffice")}</option>
          </select>
        </Field>
      </div>
    </>
  );
}
