import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import { config } from "@/lib/config";
import type { Agent, Voice } from "@/db/schema";
import { OUTBOUND_GREETING, RECORDING_NOTICE } from "@/server/agents";
import type { LlmModel, StockVoice } from "@/server/telnyx";
import { modelName, sttModelName } from "@/server/telnyx/models";
import { DEFAULT_VOICE_REF, ttsModelName } from "@/server/telnyx/stock-voices";
import { saveAgentAction } from "./actions";
import { VoiceModelFields } from "./voice-model-fields";

const DEFAULT_INSTRUCTIONS = `You are my personal phone assistant. Be concise and warm.

This call is {{call_direction}}.
- If inbound: someone called me. Ask for their name and why they're calling, and offer to take a message. Confirm the message back to them.
- If outbound: you are calling on my behalf. Your goal for this call: {{call_goal}}
  Introduce yourself as my assistant, work toward the goal, and confirm any details you agree on.

Never make commitments on my behalf beyond what the goal asks for.`;

export function AgentForm({
  agent,
  stock,
  clones,
  models,
}: {
  agent?: Agent;
  stock: StockVoice[];
  clones: Voice[];
  models: LlmModel[];
}) {
  const defaultModel = config.telnyx.llmModel;
  const otherModels = models.filter((m) => m.id !== defaultModel);
  // Keep a previously saved model selectable even if it's no longer offered.
  if (agent?.model && !otherModels.some((m) => m.id === agent.model)) {
    otherModels.push({ id: agent.model, name: modelName(agent.model), inputPricePerM: 0, outputPricePerM: 0 });
  }
  const currentVoice = agent
    ? agent.voiceId
      ? `clone:${agent.voiceId}`
      : `stock:${agent.voiceRef}`
    : stock.some((v) => v.ref === DEFAULT_VOICE_REF)
      ? `stock:${DEFAULT_VOICE_REF}`
      : "";
  const bilingual = stock.filter((v) => v.speaks.includes("zh"));
  const englishOnly = stock.filter((v) => !v.speaks.includes("zh"));
  const readyClones = clones.filter((c) => c.status === "ready");
  const ttsByVoice = Object.fromEntries([
    ...stock.map((v) => [`stock:${v.ref}`, ttsModelName(v.ref)]),
    ...readyClones.map((v) => [`clone:${v.id}`, ttsModelName(v.voiceRef ?? "")]),
  ]);
  return (
    <ActionForm action={saveAgentAction} className="space-y-5">
      {agent && <input type="hidden" name="id" value={agent.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input name="name" required maxLength={80} defaultValue={agent?.name} placeholder="My assistant" className={inputClass} />
        </Field>
        <Field label="Primary language" hint="Callers can still mix English and Mandarin.">
          <select name="language" defaultValue={agent?.language ?? "en"} className={inputClass}>
            <option value="en">English</option>
            <option value="zh">Mandarin (普通话)</option>
          </select>
        </Field>
      </div>
      <VoiceModelFields
        defaultVoice={currentVoice}
        ttsByVoice={ttsByVoice}
        sttName={sttModelName(config.telnyx.sttModel)}
        voiceOptions={
          <>
            <option value="" disabled>Choose a voice…</option>
            {readyClones.length > 0 && (
              <optgroup label="Your cloned voices">
                {readyClones.map((v) => (
                  <option key={v.id} value={`clone:${v.id}`}>{v.name}</option>
                ))}
              </optgroup>
            )}
            <optgroup label="Mandarin + English">
              {bilingual.map((v) => (
                <option key={v.ref} value={`stock:${v.ref}`}>
                  {v.name}{v.gender ? ` (${v.gender})` : ""}
                </option>
              ))}
            </optgroup>
            <optgroup label="English only">
              {englishOnly.map((v) => (
                <option key={v.ref} value={`stock:${v.ref}`}>
                  {v.name}{v.gender ? ` (${v.gender})` : ""}
                </option>
              ))}
            </optgroup>
          </>
        }
        modelSelect={
          <select name="model" defaultValue={agent?.model ?? ""} className={inputClass}>
            <option value="">{modelName(defaultModel)} (default)</option>
            {otherModels.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        }
      />
      <Field
        label="Greeting"
        hint={`The first thing the agent says when answering. A recording notice ("${RECORDING_NOTICE.en}" / "${RECORDING_NOTICE.zh}") is added automatically. On calls the agent places, it opens with "${OUTBOUND_GREETING.en}" instead.`}
      >
        <input name="greeting" required maxLength={500} defaultValue={agent?.greeting ?? "Hi, you've reached my assistant. How can I help?"} className={inputClass} />
      </Field>
      <Field
        label="Instructions"
        hint={<>How the agent should behave on calls. Use <code>{"{{call_direction}}"}</code> (inbound or outbound) and <code>{"{{call_goal}}"}</code> (what you ask for when placing a call).</>}
      >
        <textarea name="instructions" required rows={8} maxLength={8000} defaultValue={agent?.instructions ?? DEFAULT_INSTRUCTIONS} className={`${inputClass} font-mono text-xs leading-relaxed`} />
      </Field>
      <SubmitButton pendingText="Saving…">{agent ? "Save changes" : "Create agent"}</SubmitButton>
    </ActionForm>
  );
}
