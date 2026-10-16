import Link from "next/link";
import { Badge, Card, Empty, Notice, PageHeader } from "@/components/ui";
import { config } from "@/lib/config";
import { formatCents, formatDateTime, formatPhone } from "@/lib/format";
import { requireUser } from "@/server/auth";
import { listConversations } from "@/server/messages";
import { listUserNumbers } from "@/server/numbers";
import { AutoRefresh } from "../calls/auto-refresh";
import { messagePreview, threadHref } from "./format";

export default async function MessagesPage() {
  const user = await requireUser();
  const [conversations, numbers] = await Promise.all([listConversations(user.id), listUserNumbers(user.id)]);
  const active = numbers.find((n) => n.status === "active");

  return (
    <div className="space-y-6">
      <AutoRefresh everyMs={10_000} />
      <PageHeader
        title="Messages"
        description={`Texts sent to your number, ${formatCents(config.pricing.smsInboundPerPartCents)} per segment. Receive only: replies aren't supported.`}
      />

      {!config.features.inboundSms ? (
        <Notice>Receiving texts isn&apos;t turned on for this service yet.</Notice>
      ) : !active ? (
        <Notice>
          <Link href="/numbers" className="underline">Get a number</Link> to start receiving texts.
        </Notice>
      ) : (
        !active.smsEnabledAt && <Notice>Texting is still being set up for {formatPhone(active.e164)}. Check back later.</Notice>
      )}

      {conversations.length === 0 ? (
        <Empty>No texts yet.</Empty>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-stone-100">
            {conversations.map((c) => (
              <li key={c.from}>
                <Link href={threadHref(c.from)} className="flex items-start justify-between gap-4 px-5 py-3 hover:bg-stone-50">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={`whitespace-nowrap ${c.unread ? "font-semibold" : "font-medium"}`}>{c.name ?? formatPhone(c.from)}</span>
                      {c.name && <span className="whitespace-nowrap text-xs text-stone-500">{formatPhone(c.from)}</span>}
                      {c.unread > 0 && <span className="whitespace-nowrap"><Badge tone="blue">{c.unread} new</Badge></span>}
                      {c.count > 1 && <span className="whitespace-nowrap text-xs text-stone-400">{c.count} texts</span>}
                    </div>
                    <p className={`mt-0.5 truncate text-sm ${c.unread ? "text-stone-800" : "text-stone-500"}`}>{messagePreview(c.last)}</p>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-xs text-stone-500 sm:text-sm">{formatDateTime(c.last.receivedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
