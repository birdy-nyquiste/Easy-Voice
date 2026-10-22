import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardTitle, Field, Notice, inputClass } from "@/components/ui";
import { config } from "@/lib/config";
import { requireUser } from "@/server/auth";
import { getElevenLabsKey } from "@/server/elevenlabs-keys";
import { formatDateTime } from "@/lib/format";
import { connectElevenLabsAction, disconnectElevenLabsAction } from "./actions";
import { viewerTimeZone } from "@/server/time-zone";

/** Third-party accounts the user brings (docs/elevenlabs-notes.md §5). */
export default async function ApiKeysPage() {
  const user = await requireUser();
  const [elKey, t, tc, te, locale] = await Promise.all([
    getElevenLabsKey(user.id),
    getTranslations("apiKeys"),
    getTranslations("common"),
    getTranslations("errors"),
    getLocale(),
  ]);

  return (
    <div className="space-y-6">
      <p className="text-sm text-stone-500">
        {t("intro")}
      </p>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>ElevenLabs</CardTitle>
          {elKey && (elKey.keyInvalidAt ? <Badge tone="red">{t("keyRejected")}</Badge> : <Badge tone="green">{t("connectedBadge")}</Badge>)}
        </div>
        {!config.features.elevenLabs ? (
          <Notice>{te("elevenLabsUnavailable")}</Notice>
        ) : elKey ? (
          <div className="space-y-4">
            {elKey.keyInvalidAt && (
              <Notice tone="red">
                {t("rejectedNotice", { date: formatDateTime(elKey.keyInvalidAt, locale, await viewerTimeZone()) })}
              </Notice>
            )}
            <p className="text-sm text-stone-700">
              {t.rich("keyEnding", { hint: elKey.keyHint, mono: (chunks) => <span className="font-mono">{chunks}</span> })}
              {tc("sentenceGap")}
              <Link href="/voices" className="underline hover:text-stone-900">
                {t("cloneLink")}
              </Link>
            </p>
            {/* Distinct keys so a key typed to connect isn't carried into this field. */}
            <ActionForm key="replace" action={connectElevenLabsAction} className="flex flex-wrap items-end gap-2">
              <div className="min-w-64 flex-1">
                <Field label={t("replaceKey")} hint={t("replaceHint")}>
                  <input name="apiKey" type="password" required autoComplete="off" placeholder="sk_…" className={inputClass} />
                </Field>
              </div>
              <SubmitButton variant="secondary" pendingText={tc("checking")}>
                {t("replace")}
              </SubmitButton>
            </ActionForm>
            <ActionForm action={disconnectElevenLabsAction}>
              <SubmitButton
                variant="danger"
                confirm={t("disconnectConfirm")}
              >
                {t("disconnect")}
              </SubmitButton>
            </ActionForm>
          </div>
        ) : (
          <ActionForm key="connect" action={connectElevenLabsAction} className="space-y-4">
            <p className="text-sm text-stone-700">
              {t("connectIntro")}
            </p>
            <Field
              label={t("keyLabel")}
              hint={t("keyHint")}
            >
              <input name="apiKey" type="password" required autoComplete="off" placeholder="sk_…" className={inputClass} />
            </Field>
            <SubmitButton pendingText={tc("checking")}>{t("connect")}</SubmitButton>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
