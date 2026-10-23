import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardTitle, Field, Notice, PageHeader, StatusBadge, Tabs, VoiceGender, inputClass } from "@/components/ui";
import { PreviewButton } from "@/components/voice-preview";
import { config } from "@/lib/config";
import { formatCents, formatMegabytes } from "@/lib/format";
import { showStored } from "@/lib/stored-text";
import { requireUser } from "@/server/auth";
import { getElevenLabsKey } from "@/server/elevenlabs-keys";
import { hasCloneSlot, listStockVoices, listUserVoices, refreshProcessingVoices } from "@/server/voices";
import { cloneVoiceAction, deleteVoiceAction } from "./actions";
import { SampleInput } from "./sample-input";

/**
 * Voice Library: every voice the user can give an agent, cloned or built-in, side by side.
 * Voice Lab: ways to make new voices (only cloning from a sample so far).
 */
export default async function VoicesPage({ searchParams }: { searchParams: Promise<{ library?: string }> }) {
  const user = await requireUser();
  await refreshProcessingVoices(user.id);
  const [stock, clones, elKey, { library }] = await Promise.all([
    listStockVoices(),
    listUserVoices(user.id),
    getElevenLabsKey(user.id),
    searchParams,
  ]);
  const [t, tc, tl, te, locale] = await Promise.all([
    getTranslations("voices"),
    getTranslations("common"),
    getTranslations("languages"),
    getTranslations("errors"),
    getLocale(),
  ]);
  const tab = library === "cloned" || library === "built-in" ? library : clones.length ? "cloned" : "built-in";

  const cloning = config.features.voiceCloning;
  const elevenLabs = config.features.elevenLabs;
  // Clone providers the form offers, in order: ours, then third-party accounts the user has connected.
  const providers = [
    ...(cloning && hasCloneSlot(clones, "telnyx") ? (["telnyx"] as const) : []),
    ...(elevenLabs && elKey && hasCloneSlot(clones, "elevenlabs") ? (["elevenlabs"] as const) : []),
  ];
  // Third-party accounts are set up under Account → API keys, not here.
  const canAddService = elevenLabs && !elKey;
  const max = config.limits.clonedVoicesPerUser;
  const noProviderReason = canAddService
    ? cloning
      ? t("cloneLimitOrConnect", { max })
      : t("connectToClone")
    : cloning || (elevenLabs && elKey)
      ? t("cloneLimit", { max })
      : te("cloningUnavailable");
  // Only clones the provider has accepted: one that never got there would keep the page polling.
  const inProgress = clones.some((c) => c.status === "processing" && c.providerVoiceId);

  return (
    <div className="space-y-6">
      {inProgress && <AutoRefresh everyMs={4000} />}
      <PageHeader title={t("title")} description={t("description")} />

      <Card>
        <CardTitle>{t("library")}</CardTitle>
        <Tabs
          tabs={[
            { href: "/voices?library=cloned", label: t("clonedTab", { count: clones.length }), active: tab === "cloned" },
            { href: "/voices?library=built-in", label: t("builtInTab", { count: stock.length }), active: tab === "built-in" },
          ]}
        />
        <div className="pt-4">
          {tab === "cloned" ? (
            clones.length === 0 ? (
              <p className="text-sm text-stone-500">{t("noClones")}</p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {clones.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{v.name}</span>
                      <Badge>{tl(v.language)}</Badge>
                      {v.provider === "elevenlabs" && <Badge tone="blue">ElevenLabs</Badge>}
                      <StatusBadge status={v.status} />
                      {v.failureReason && <span className="text-red-600">{showStored(locale, v.failureReason, v.failureMsg)}</span>}
                    </span>
                    <span className="flex items-center gap-1">
                      {v.providerVoiceId && v.status !== "failed" && <PreviewButton voice={`clone:${v.id}`} name={v.name} compact />}
                      <ActionForm action={deleteVoiceAction}>
                        <input type="hidden" name="voiceId" value={v.id} />
                        <SubmitButton
                          variant="danger"
                          confirm={
                            // Only a clone ElevenLabs made is in the user's account there.
                            v.provider === "elevenlabs" && v.providerVoiceId
                              ? t("deleteConfirmElevenLabs", { name: v.name })
                              : t("deleteConfirm", { name: v.name })
                          }
                        >
                          {tc("delete")}
                        </SubmitButton>
                      </ActionForm>
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {stock.map((v) => (
                <li key={v.ref} className="flex items-start gap-1 rounded-lg border border-stone-100 px-3 py-2 text-sm">
                  <PreviewButton voice={`stock:${v.ref}`} name={v.name} compact />
                  <span className="min-w-0 space-y-1">
                    <span className="block font-medium">{v.name}</span>
                    <span className="flex flex-wrap gap-1.5">
                      {v.speaks.includes("zh") ? <Badge tone="green">{tl("bilingual")}</Badge> : <Badge>{tl("englishOnly")}</Badge>}
                      {v.gender && <Badge><VoiceGender gender={v.gender} /></Badge>}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>{t("lab")}</CardTitle>
        {/* One method today; more (e.g. designing a voice from a description) can join as tabs. */}
        <Tabs tabs={[{ href: "/voices", label: t("cloneTab"), active: true }]} />
        <div className="space-y-4 pt-4">
          <p className="text-sm text-stone-500">{t("labIntro")}</p>
          {/* Once ElevenLabs is connected the Easy Voice option simply isn't offered; no notice needed. */}
          {!cloning && canAddService && (
            <Notice>
              {te("cloningUnavailable")}
              {tc("sentenceGap")}
              {t("useOwnElevenLabs")}
            </Notice>
          )}
          {providers.length === 0 && !canAddService ? (
            <p className="text-sm text-stone-500">{noProviderReason}</p>
          ) : (
            <ActionForm action={cloneVoiceAction} className="space-y-4" resetOnSuccess>
              <Field label={t("cloneWith")}>
                <div className="grid gap-2 sm:grid-cols-3">
                  {providers.map((p, i) => (
                    <label
                      key={p}
                      className="flex cursor-pointer items-start gap-2 rounded-lg border border-stone-200 px-3 py-2 text-sm has-[:checked]:border-stone-900"
                    >
                      <input type="radio" name="provider" value={p} defaultChecked={i === 0} required className="mt-0.5" />
                      <span>
                        <span className="font-medium">{p === "elevenlabs" ? "ElevenLabs" : "Easy Voice"}</span>
                        <span className="block text-stone-500">
                          {p === "elevenlabs"
                            ? t("elevenLabsOption")
                            : t("easyVoiceOption", { price: formatCents(config.pricing.voiceCloneCents, locale) })}
                        </span>
                      </span>
                    </label>
                  ))}
                  {canAddService && (
                    <Link
                      href="/account/api-keys"
                      className="flex items-center gap-2 rounded-lg border border-dashed border-stone-300 px-3 py-2 text-sm text-stone-600 hover:border-stone-500 hover:text-stone-900"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-stone-300 text-base leading-none">
                        +
                      </span>
                      <span>
                        <span className="font-medium">{t("addService")}</span>
                        <span className="block text-stone-500">{t("addServiceHint")}</span>
                      </span>
                    </Link>
                  )}
                </div>
              </Field>
              {providers.length === 0 ? (
                <p className="text-sm text-stone-500">{noProviderReason}</p>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label={tc("name")}>
                      <input name="name" required maxLength={60} placeholder={t("namePlaceholder")} className={inputClass} />
                    </Field>
                    <Field label={t("sampleLanguage")}>
                      <select name="language" className={inputClass}>
                        <option value="en">{tl("en")}</option>
                        <option value="zh">{tl("zh")}</option>
                      </select>
                    </Field>
                    <Field label={t("voiceType")}>
                      <select name="gender" className={inputClass}>
                        <option value="female">{t("female")}</option>
                        <option value="male">{t("male")}</option>
                      </select>
                    </Field>
                  </div>
                  <Field
                    label={t("sample")}
                    hint={t(providers.includes("elevenlabs") ? "sampleHintElevenLabs" : "sampleHint", {
                      max: formatMegabytes(config.limits.cloneSampleBytes, locale),
                    })}
                  >
                    <SampleInput maxBytes={config.limits.cloneSampleBytes} />
                  </Field>
                  <label className="flex items-start gap-2 text-sm text-stone-700">
                    <input type="checkbox" name="consent" required className="mt-0.5" />
                    <span>{t("consent")}</span>
                  </label>
                  <SubmitButton pendingText={t("uploading")}>{t("clone")}</SubmitButton>
                </>
              )}
            </ActionForm>
          )}
        </div>
      </Card>
    </div>
  );
}
