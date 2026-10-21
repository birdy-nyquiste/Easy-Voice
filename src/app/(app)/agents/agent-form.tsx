import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardTitle, Field, inputClass } from "@/components/ui";
import { MAX_CALL_MINUTES, MAX_KEY_TERMS_LENGTH, readBehavior, readVariables, SILENCE_HANGUP_SECS } from "@/lib/agent-settings";
import type { AgentTemplate } from "@/lib/agent-templates";
import { config } from "@/lib/config";
import type { Agent, Voice } from "@/db/schema";
import { OUTBOUND_GREETING, RECORDING_NOTICE } from "@/server/agents";
import type { LlmModel, StockVoice } from "@/server/telnyx";
import { modelName, sttModelName } from "@/server/telnyx/models";
import { DEFAULT_VOICE_REF, ttsModelName } from "@/server/telnyx/stock-voices";
import { saveAgentAction } from "./actions";
import { ModelRow } from "./model-row";
import { ScriptFields } from "./script-fields";
import { VoiceFields } from "./voice-fields";

/**
 * The agent's settings, in setup order: who answers and how it sounds, what it says, how it handles
 * the conversation, and when calls end. A new agent starts from a template.
 */
export function AgentForm({
  agent,
  template,
  templateName = "",
  stock,
  clones,
  models,
}: {
  agent?: Agent;
  /** For a new agent: what the form starts with. */
  template?: AgentTemplate;
  templateName?: string;
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
  const initial = agent ?? template;
  const behavior = readBehavior(agent ? agent.behavior : template?.behavior);
  const variables = agent ? readVariables(agent.variables) : (template?.variables ?? []);
  return (
    <ActionForm action={saveAgentAction} className="space-y-6">
      {agent && <input type="hidden" name="id" value={agent.id} />}

      <Section title={t("sectionIdentity")} description={t("sectionIdentityHint")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tc("name")}>
            <input name="name" required maxLength={80} defaultValue={agent?.name ?? templateName} placeholder={t("namePlaceholder")} className={inputClass} />
          </Field>
          <Field label={t("language")} hint={t("languageHint")}>
            <select name="language" defaultValue={initial?.language ?? "en"} className={inputClass}>
              <option value="en">{tl("en")}</option>
              <option value="zh">{tl("zhNative")}</option>
            </select>
          </Field>
        </div>
        <VoiceFields
          defaultVoice={currentVoice}
          ttsByVoice={ttsByVoice}
          behavior={behavior}
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
        />
      </Section>

      <Section title={t("sectionInstructions")} description={t("sectionInstructionsHint")}>
        <ScriptFields
          greeting={initial?.greeting ?? ""}
          instructions={initial?.instructions ?? ""}
          variables={variables}
          timeZone={behavior.timeZone}
          guessTimeZone={!agent}
          greetingHint={t("greetingHint", {
            noticeEn: RECORDING_NOTICE.en,
            noticeZh: RECORDING_NOTICE.zh,
            outboundEn: OUTBOUND_GREETING.en,
            outboundZh: OUTBOUND_GREETING.zh,
          })}
        />
        <Field label={t("llm")} hint={t("llmHint")}>
          <select name="model" defaultValue={agent?.model ?? ""} className={inputClass}>
            <option value="">{t("defaultModel", { name: modelName(defaultModel) })}</option>
            {otherModels.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title={t("sectionConversation")} description={t("sectionConversationHint")}>
        <Field label={t("responseTiming")}>
          <select name="responseTiming" defaultValue={behavior.responseTiming} className={inputClass}>
            <option value="quick">{t("timingQuick")}</option>
            <option value="balanced">{t("timingBalanced")}</option>
            <option value="patient">{t("timingPatient")}</option>
          </select>
        </Field>
        <div className="space-y-2">
          <Toggle name="allowInterruptions" defaultChecked={behavior.allowInterruptions} label={t("allowInterruptions")} />
          <Toggle
            name="greetingInterruptible"
            defaultChecked={behavior.greetingInterruptible}
            label={t("greetingInterruptible")}
            hint={t("greetingInterruptibleHint")}
          />
        </div>
        <ModelRow label={t("stt")}>
          <span className="font-medium">{sttModelName(config.telnyx.sttModel)}</span>
        </ModelRow>
        <Field label={t("keyTerms")} hint={t("keyTermsHint")}>
          <input
            name="keyTerms"
            maxLength={MAX_KEY_TERMS_LENGTH}
            defaultValue={behavior.keyTerms}
            placeholder={t("keyTermsPlaceholder")}
            className={inputClass}
          />
        </Field>
      </Section>

      <Section title={t("sectionEnding")} description={t("sectionEndingHint")}>
        <Toggle name="endCallWhenDone" defaultChecked={behavior.endCallWhenDone} label={t("endCallWhenDone")} hint={t("endCallWhenDoneHint")} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("maxCallLength")}>
            <select name="maxCallMinutes" defaultValue={behavior.maxCallMinutes} className={inputClass}>
              {MAX_CALL_MINUTES.map((m) => (
                <option key={m} value={m}>{t("minutes", { count: m })}</option>
              ))}
            </select>
          </Field>
          <Field label={t("silenceHangup")} hint={t("silenceHangupHint")}>
            <select name="silenceHangupSecs" defaultValue={behavior.silenceHangupSecs} className={inputClass}>
              {SILENCE_HANGUP_SECS.map((secs) => (
                <option key={secs} value={secs}>{secs ? t("afterSeconds", { count: secs }) : t("never")}</option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      <div>
        <SubmitButton pendingText={tc("saving")}>{agent ? t("saveChanges") : t("create")}</SubmitButton>
      </div>
    </ActionForm>
  );
}

/** One card of the form, styled like the page's other cards (knowledge base, danger zone). */
function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div className="space-y-4">
        <p className="text-sm text-stone-600">{description}</p>
        {children}
      </div>
    </Card>
  );
}

function Toggle({ name, label, hint, defaultChecked }: { name: string; label: string; hint?: string; defaultChecked: boolean }) {
  return (
    <label className="flex items-start gap-3">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-0.5 h-4 w-4 accent-stone-900" />
      <span>
        <span className="block text-sm font-medium text-stone-700">{label}</span>
        {hint && <span className="block text-xs text-stone-500">{hint}</span>}
      </span>
    </label>
  );
}
