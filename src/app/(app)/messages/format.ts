import type { getTranslations } from "next-intl/server";
import type { Message } from "@/db/schema";

type T = Awaited<ReturnType<typeof getTranslations<"messages">>>;

export function threadHref(from: string): string {
  return `/messages/thread?from=${encodeURIComponent(from)}`;
}

export function attachmentNote(m: Pick<Message, "mediaCount">, t: T): string | null {
  if (!m.mediaCount) return null;
  return t("attachments", { count: m.mediaCount });
}

export function messagePreview(m: Message, t: T): string {
  if (m.body == null) return t("retentionDeleted");
  return m.body || attachmentNote(m, t) || t("emptyText");
}
