import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, PageHeader, inputClass } from "@/components/ui";
import { config } from "@/lib/config";
import { formatCents, formatDateTime, formatPhone } from "@/lib/format";
import { requireUser } from "@/server/auth";
import { getContactName, getConversation, MAX_CONTACT_NAME_LENGTH } from "@/server/messages";
import { AutoRefresh } from "@/components/auto-refresh";
import { deleteConversationAction, saveContactNameAction } from "../actions";
import { messageBody } from "../format";
import { MarkRead } from "./mark-read";
import { viewerTimeZone } from "@/server/time-zone";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ from?: string }> }): Promise<Metadata> {
  const [user, { from }, t] = await Promise.all([requireUser(), searchParams, getTranslations("messages")]);
  if (!from) return { title: t("title") };
  return { title: t("threadTitle", { name: (await getContactName(user.id, from)) ?? formatPhone(from) }) };
}

export default async function ThreadPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const user = await requireUser();
  const { from } = await searchParams;
  if (!from) notFound();
  const [texts, name] = await Promise.all([getConversation(user.id, from), getContactName(user.id, from)]);
  if (texts.length === 0) notFound();
  const billed = texts.reduce((sum, m) => sum + m.billedCents, 0);
  const [t, tc, locale] = await Promise.all([getTranslations("messages"), getTranslations("common"), getLocale()]);
  const tz = await viewerTimeZone();
  const who = name ?? formatPhone(from);

  return (
    <div className="space-y-6">
      <AutoRefresh everyMs={10_000} maxMs={Infinity} />
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
          {texts.map((m) => {
            const { text, placeholder, note } = messageBody(m, t);
            return (
              <li key={m.id} className="max-w-prose">
                <div className="inline-block whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm bg-stone-100 px-4 py-2 text-sm text-stone-900">
                  {placeholder ? <span className="italic text-stone-500">{text}</span> : text}
                  {note && <span className="mt-1 block text-xs text-stone-500">{note}</span>}
                </div>
                <div className="mt-1 text-xs text-stone-500">{formatDateTime(m.receivedAt, locale, tz)}</div>
              </li>
            );
          })}
        </ul>
        <p className="mt-6 border-t border-stone-100 pt-3 text-xs text-stone-500">
          {t("footer", { days: config.policy.retentionDays })}
        </p>
      </Card>
    </div>
  );
}
