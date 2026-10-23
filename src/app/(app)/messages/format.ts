import type { getTranslations } from "next-intl/server";
import type { Message } from "@/db/schema";
import { config } from "@/lib/config";

type T = Awaited<ReturnType<typeof getTranslations<"messages">>>;

export function threadHref(from: string): string {
  return `/messages/thread?from=${encodeURIComponent(from)}`;
}

/**
 * What a text says, for both the list and the thread: its body, or a placeholder (shown in italics)
 * when retention has purged it or it had no words, plus a note about attachments we don't show.
 */
export function messageBody(m: Message, t: T): { text: string; placeholder: boolean; note: string | null } {
  if (m.body == null) return { text: t("deletedAfter", { days: config.policy.retentionDays }), placeholder: true, note: null };
  const note = m.mediaCount ? t("attachments", { count: m.mediaCount }) : null;
  return m.body ? { text: m.body, placeholder: false, note } : { text: t("noText"), placeholder: true, note };
}

/** One line for the conversation list; a picture-only text shows its attachment count. */
export function messagePreview(m: Message, t: T): string {
  const { text, placeholder, note } = messageBody(m, t);
  return placeholder && note ? note : text;
}
