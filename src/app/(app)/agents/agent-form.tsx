import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import type { Agent, Voice } from "@/db/schema";
import { RECORDING_NOTICE } from "@/server/agents";
import type { StockVoice } from "@/server/telnyx";
import { saveAgentAction } from "./actions";

const DEFAULT_INSTRUCTIONS = `You are a friendly personal assistant answering phone calls for me.
Be concise and warm. Ask the caller for their name and the reason for the call.
If they want to leave a message, confirm the details back to them.
Never make commitments on my behalf.`;

export function AgentForm({ agent, stock, clones }: { agent?: Agent; stock: StockVoice[]; clones: Voice[] }) {
  const currentVoice = agent ? (agent.voiceId ? `clone:${agent.voiceId}` : `stock:${agent.voiceRef}`) : "";
  const readyClones = clones.filter((c) => c.status === "ready");
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
      <Field label="Voice">
        <select name="voice" required defaultValue={currentVoice} className={inputClass}>
          <option value="" disabled>Choose a voice…</option>
          {readyClones.length > 0 && (
            <optgroup label="Your cloned voices">
              {readyClones.map((v) => (
                <option key={v.id} value={`clone:${v.id}`}>{v.name}</option>
              ))}
            </optgroup>
          )}
          <optgroup label="Built-in voices">
            {stock.map((v) => (
              <option key={v.ref} value={`stock:${v.ref}`}>
                {v.name} — {v.language}{v.gender ? `, ${v.gender}` : ""}
              </option>
            ))}
          </optgroup>
        </select>
      </Field>
      <Field
        label="Greeting"
        hint={`The first thing the agent says. A recording notice ("${RECORDING_NOTICE.en}" / "${RECORDING_NOTICE.zh}") is added automatically.`}
      >
        <input name="greeting" required maxLength={500} defaultValue={agent?.greeting ?? "Hi, you've reached my assistant. How can I help?"} className={inputClass} />
      </Field>
      <Field label="Instructions" hint="How the agent should behave on calls.">
        <textarea name="instructions" required rows={8} maxLength={8000} defaultValue={agent?.instructions ?? DEFAULT_INSTRUCTIONS} className={`${inputClass} font-mono text-xs leading-relaxed`} />
      </Field>
      <SubmitButton pendingText="Saving…">{agent ? "Save changes" : "Create agent"}</SubmitButton>
    </ActionForm>
  );
}
