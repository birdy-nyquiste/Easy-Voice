import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Card, CardTitle, Field, Notice, inputClass } from "@/components/ui";
import { MAX_CALL_MINUTES, MAX_KEY_TERMS_LENGTH, readBehavior, readVariables, SILENCE_HANGUP_SECS } from "@/lib/agent-settings";
import type { AgentTemplate } from "@/lib/agent-templates";
import { config } from "@/lib/config";
import type { Agent, Voice } from "@/db/schema";
import { OUTBOUND_GREETING, RECORDING_NOTICE } from "@/server/agents";
import type { LlmModel, StockVoice } from "@/server/telnyx";
import { modelName, sttModelName } from "@/server/telnyx/models";
import { DEFAULT_VOICE_REF, ttsModelName, voiceSpeaks } from "@/server/telnyx/stock-voices";
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
  stock: catalog,
  clones,
  models,
  saved = false,
}: {
  agent?: Agent;
  /** Just saved: show "Saved." next to the button until the next save. */
  saved?: boolean;
  /** For a new agent: what the form starts with. */
  template?: AgentTemplate;
  templateName?: string;
  /** Built-in voices; null when the catalog couldn't be loaded. */
  stock: StockVoice[] | null;
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
  // Keep a previously saved model selectable even if it's no longer offered, marked as such: saving
  // asks for another one. (An empty list means the catalog couldn't be loaded, not that it's gone.)
  const savedModel = agent?.model;
  if (savedModel && !otherModels.some((m) => m.id === savedModel)) {
    const name = modelName(savedModel);
    const gone = models.length > 0 && savedModel !== defaultModel;
    otherModels.push({ id: savedModel, name: gone ? t("modelGone", { name }) : name, inputPricePerM: 0, outputPricePerM: 0 });
  }
  // Without the catalog, keep the agent's current built-in voice on offer rather than reporting it gone.
  const stock =
    catalog ??
    (agent && !agent.voiceId ? [{ ref: agent.voiceRef, name: t("currentVoice"), language: agent.language, speaks: voiceSpeaks(agent.voiceRef) }] : []);
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
  // A voice that left the catalog (or a clone that's no longer usable) can't be saved again, and a
  // select whose value has no option silently submits the first one. Start empty instead, and say why.
  const voiceGone = Boolean(agent) && !(currentVoice in ttsByVoice);
  const initial = agent ?? template;
  const behavior = readBehavior(agent ? agent.behavior : template?.behavior);
  const variables = agent ? readVariables(agent.variables) : (template?.variables ?? []);
  return (
    <ActionForm action={saveAgentAction} className="space-y-6" message="custom">
      {agent && <input type="hidden" name="id" value={agent.id} />}

      {/* The result goes next to the button: below the last card it would be far out of view. */}
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        <FormMessage initialOk={saved ? tc("saved") : undefined} />
        <SubmitButton pendingText={tc("saving")}>{agent ? t("saveChanges") : t("create")}</SubmitButton>
      </div>

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
        {!catalog && <Notice>{t("voicesUnavailable")}</Notice>}
        <VoiceFields
          defaultVoice={voiceGone ? "" : currentVoice}
          voiceGone={voiceGone}
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
