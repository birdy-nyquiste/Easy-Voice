import { useTranslations } from "next-intl";
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
  const t = useTranslations("agents");
  const tc = useTranslations("common");
  const tl = useTranslations("languages");
  const tg = useTranslations("gender");
  const gender = (g: string) => (g === "female" || g === "male" ? tg(g) : g);
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
  // While a provider's cloning is off, keep only the clone this agent already uses (so the picker shows it).
  const readyClones = clones.filter(
    (c) =>
      c.status === "ready" &&
      ((c.provider === "elevenlabs" ? config.features.elevenLabs : config.features.voiceCloning) || c.id === agent?.voiceId),
  );
  const ttsByVoice = Object.fromEntries([
    ...stock.map((v) => [`stock:${v.ref}`, ttsModelName(v.ref)]),
    ...readyClones.map((v) => [`clone:${v.id}`, ttsModelName(v.voiceRef ?? "")]),
  ]);
  return (
    <ActionForm action={saveAgentAction} className="space-y-5">
      {agent && <input type="hidden" name="id" value={agent.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tc("name")}>
          <input name="name" required maxLength={80} defaultValue={agent?.name} placeholder={t("namePlaceholder")} className={inputClass} />
        </Field>
        <Field label={t("language")} hint={t("languageHint")}>
          <select name="language" defaultValue={agent?.language ?? "en"} className={inputClass}>
            <option value="en">{tl("en")}</option>
            <option value="zh">{tl("zhNative")}</option>
          </select>
        </Field>
      </div>
      <VoiceModelFields
        defaultVoice={currentVoice}
        ttsByVoice={ttsByVoice}
        sttName={sttModelName(config.telnyx.sttModel)}
        voiceOptions={
          <>
            <option value="" disabled>{t("chooseVoice")}</option>
            {readyClones.length > 0 && (
              <optgroup label={t("yourClones")}>
                {readyClones.map((v) => (
                  <option key={v.id} value={`clone:${v.id}`}>
                    {v.name}{v.provider === "elevenlabs" ? " (ElevenLabs)" : ""}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label={tl("bilingual")}>
              {bilingual.map((v) => (
                <option key={v.ref} value={`stock:${v.ref}`}>
                  {v.gender ? t("voiceWithGender", { name: v.name, gender: gender(v.gender) }) : v.name}
                </option>
              ))}
            </optgroup>
            <optgroup label={tl("englishOnly")}>
              {englishOnly.map((v) => (
                <option key={v.ref} value={`stock:${v.ref}`}>
                  {v.gender ? t("voiceWithGender", { name: v.name, gender: gender(v.gender) }) : v.name}
                </option>
              ))}
            </optgroup>
          </>
        }
        modelSelect={
          <select name="model" defaultValue={agent?.model ?? ""} className={inputClass}>
            <option value="">{t("defaultModel", { name: modelName(defaultModel) })}</option>
            {otherModels.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        }
      />
      <Field
        label={t("greeting")}
        hint={t("greetingHint", {
          noticeEn: RECORDING_NOTICE.en,
          noticeZh: RECORDING_NOTICE.zh,
          outboundEn: OUTBOUND_GREETING.en,
          outboundZh: OUTBOUND_GREETING.zh,
        })}
      >
        <input name="greeting" required maxLength={500} defaultValue={agent?.greeting ?? "Hi, you've reached my assistant. How can I help?"} className={inputClass} />
      </Field>
      <Field
        label={t("instructions")}
        hint={t.rich("instructionsHint", { code: (chunks) => <code>{chunks}</code> })}
      >
        <textarea name="instructions" required rows={8} maxLength={8000} defaultValue={agent?.instructions ?? DEFAULT_INSTRUCTIONS} className={`${inputClass} font-mono text-xs leading-relaxed`} />
      </Field>
      <SubmitButton pendingText={tc("saving")}>{agent ? t("saveChanges") : t("create")}</SubmitButton>
    </ActionForm>
  );
}
