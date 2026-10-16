import Link from "next/link";
import { notFound } from "next/navigation";
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

  return (
    <div className="space-y-6">
      <AutoRefresh everyMs={10_000} />
      <MarkRead from={from} upTo={texts[texts.length - 1].receivedAt.toISOString()} hasUnread={texts.some((m) => !m.readAt)} />
      <Link href="/messages" className="text-sm text-stone-500 hover:text-stone-900">← Messages</Link>
      <PageHeader
        title={`Texts from ${name ?? formatPhone(from)}`}
        description={[name && formatPhone(from), `${texts.length} text${texts.length === 1 ? "" : "s"}`, `${formatCents(billed)} billed`].filter(Boolean).join(" · ")}
        action={
          <ActionForm action={deleteConversationAction}>
            <input type="hidden" name="from" value={from} />
            <SubmitButton variant="danger" confirm={`Delete all texts from ${name ?? formatPhone(from)}? This can't be undone.`}>
              Delete conversation
            </SubmitButton>
          </ActionForm>
        }
      />

      <ActionForm action={saveContactNameAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="number" value={from} />
        <label htmlFor="contact-name" className="text-sm font-medium text-stone-700">Name</label>
        {/* inputClass is w-full, so the wrapper sets the width. */}
        <div className="w-64 max-w-full">
          <input
            id="contact-name"
            name="name"
            defaultValue={name ?? ""}
            maxLength={MAX_CONTACT_NAME_LENGTH}
            placeholder={`e.g. Dr. Lee's office`}
            className={inputClass}
          />
        </div>
        <SubmitButton variant="secondary">Save</SubmitButton>
      </ActionForm>

      <Card>
        <ul className="space-y-4">
          {texts.map((m) => (
            <li key={m.id} className="max-w-prose">
              <div className="inline-block whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm bg-stone-100 px-4 py-2 text-sm text-stone-900">
                {m.body == null ? <span className="italic text-stone-500">Deleted after {config.policy.retentionDays} days.</span> : m.body || <span className="italic text-stone-500">(no text)</span>}
                {m.body != null && attachmentNote(m) && <span className="mt-1 block text-xs text-stone-500">{attachmentNote(m)}</span>}
              </div>
              <div className="mt-1 text-xs text-stone-400">{formatDateTime(m.receivedAt)}</div>
            </li>
          ))}
        </ul>
        <p className="mt-6 border-t border-stone-100 pt-3 text-xs text-stone-500">
          You can&apos;t reply from Easy Voice. Texts are deleted after {config.policy.retentionDays} days.
        </p>
      </Card>
    </div>
  );
}
