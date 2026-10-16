import type { Message } from "@/db/schema";

export function threadHref(from: string): string {
  return `/messages/thread?from=${encodeURIComponent(from)}`;
}

export function attachmentNote(m: Pick<Message, "mediaCount">): string | null {
  if (!m.mediaCount) return null;
  return `${m.mediaCount} attachment${m.mediaCount === 1 ? "" : "s"} (not shown)`;
}

export function messagePreview(m: Message): string {
  if (m.body == null) return "Deleted after the retention period.";
  return m.body || attachmentNote(m) || "(empty)";
}
