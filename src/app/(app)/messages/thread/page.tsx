import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, PageHeader, inputClass } from "@/components/ui";
import { config } from "@/lib/config";
import { formatCents, formatDateTime, formatPhone } from "@/lib/format";
import { requireUser } from "@/server/auth";
import { getContactName, getConversation, MAX_CONTACT_NAME_LENGTH } from "@/server/messages";
import { AutoRefresh } from "../../calls/auto-refresh";
import { deleteConversationAction, saveContactNameAction } from "../actions";
import { attachmentNote } from "../format";
import { MarkRead } from "./mark-read";

export default async function ThreadPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const user = await requireUser();
  const { from } = await searchParams;
  if (!from) notFound();
  const [texts, name] = await Promise.all([getConversation(user.id, from), getContactName(user.id, from)]);
  if (texts.length === 0) notFound();
  const billed = texts.reduce((sum, m) => sum + m.billedCents, 0);
  const [t, tc, locale] = await Promise.all([getTranslations("messages"), getTranslations("common"), getLocale()]);
  const who = name ?? formatPhone(from);

  return (
    <div className="space-y-6">
      <AutoRefresh everyMs={10_000} />
      <MarkRead from={from} upTo={texts[texts.length - 1].receivedAt.toISOString()} hasUnread={texts.some((m) => !m.readAt)} />
      <PageHeader
        back={{ href: "/messages", label: t("all") }}
        title={t("threadTitle", { name: who })}
        description={[name && formatPhone(from), t("textCount", { count: texts.length }), t("billed", { amount: formatCents(billed, locale) })].filter(Boolean).join(" · ")}
        action={
          <ActionForm action={deleteConversationAction}>
            <input type="hidden" name="from" value={from} />
            <SubmitButton variant="danger" confirm={t("deleteConfirm", { name: who })}>
              {t("delete")}
            </SubmitButton>
          </ActionForm>
        }
      />

      <ActionForm action={saveContactNameAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="number" value={from} />
        <label htmlFor="contact-name" className="text-sm font-medium text-stone-700">{tc("name")}</label>
        {/* inputClass is w-full, so the wrapper sets the width. */}
        <div className="w-64 max-w-full">
          <input
            id="contact-name"
            name="name"
            defaultValue={name ?? ""}
            maxLength={MAX_CONTACT_NAME_LENGTH}
            placeholder={t("namePlaceholder")}
            className={inputClass}
          />
        </div>
        <SubmitButton variant="secondary">{tc("save")}</SubmitButton>
      </ActionForm>

      <Card>
        <ul className="space-y-4">
          {texts.map((m) => (
            <li key={m.id} className="max-w-prose">
              <div className="inline-block whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm bg-stone-100 px-4 py-2 text-sm text-stone-900">
                {m.body == null ? (
                  <span className="italic text-stone-500">{t("deletedAfter", { days: config.policy.retentionDays })}</span>
                ) : (
                  m.body || <span className="italic text-stone-500">{t("noText")}</span>
                )}
                {m.body != null && attachmentNote(m, t) && <span className="mt-1 block text-xs text-stone-500">{attachmentNote(m, t)}</span>}
              </div>
              <div className="mt-1 text-xs text-stone-400">{formatDateTime(m.receivedAt, locale)}</div>
            </li>
          ))}
        </ul>
        <p className="mt-6 border-t border-stone-100 pt-3 text-xs text-stone-500">
          {t("footer", { days: config.policy.retentionDays })}
        </p>
      </Card>
    </div>
  );
}
