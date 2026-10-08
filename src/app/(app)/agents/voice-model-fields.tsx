"use client";

import { useState, type ReactNode } from "react";
import { Field, inputClass } from "@/components/ui";
import { PreviewButton } from "@/components/voice-preview";

/**
 * The agent's voice picker (with preview) and the models a call runs on. Only the language
 * model is configurable; speech recognition is fixed and text-to-speech follows the voice.
 */
export function VoiceModelFields({
  defaultVoice,
  voiceOptions,
  ttsByVoice,
  sttName,
  modelSelect,
}: {
  defaultVoice: string;
  voiceOptions: ReactNode;
  /** Voice picker value → display name of its speech model. */
  ttsByVoice: Record<string, string>;
  sttName: string;
  modelSelect: ReactNode;
}) {
  const [voice, setVoice] = useState(defaultVoice);
  return (
    <>
      <Field label="Voice" hint="Mandarin agents need a Mandarin + English voice. English-only voices always reply in English.">
        <div className="flex gap-2">
          <select name="voice" required value={voice} onChange={(e) => setVoice(e.target.value)} className={inputClass}>
            {voiceOptions}
          </select>
          <PreviewButton voice={voice} />
        </div>
      </Field>
      <div className="space-y-2">
        <span className="text-sm font-medium text-stone-700">Models</span>
        <dl className="divide-y divide-stone-100 rounded-lg border border-stone-200 text-sm">
          <div className="grid items-center gap-1 px-3 py-2.5 sm:grid-cols-[11rem_1fr]">
            <dt className="text-stone-500">Speech recognition</dt>
            <dd className="font-medium">{sttName}</dd>
          </div>
          <div className="grid items-center gap-1 px-3 py-2 sm:grid-cols-[11rem_1fr]">
            <dt className="text-stone-500">Language model</dt>
            <dd>{modelSelect}</dd>
          </div>
          <div className="grid items-center gap-1 px-3 py-2.5 sm:grid-cols-[11rem_1fr]">
            <dt className="text-stone-500">Text-to-speech</dt>
            <dd>
              <span className="font-medium">{ttsByVoice[voice] ?? "—"}</span>
              <span className="text-stone-500"> · set by the voice</span>
            </dd>
          </div>
        </dl>
        <span className="block text-xs text-stone-500">
          The language model decides what the agent says. Calls cost the same with any model.
        </span>
      </div>
    </>
  );
}
