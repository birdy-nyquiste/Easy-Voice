import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Badge, Card, Empty, Notice, PageHeader } from "@/components/ui";
import { config } from "@/lib/config";
import { formatCents, formatDateTime, formatPhone } from "@/lib/format";
import { requireUser } from "@/server/auth";
import { listConversations } from "@/server/messages";
import { listUserNumbers } from "@/server/numbers";
import { AutoRefresh } from "@/components/auto-refresh";
import { messagePreview, threadHref } from "./format";
import { viewerTimeZone } from "@/server/time-zone";

export default async function MessagesPage() {
  const user = await requireUser();
  const [conversations, numbers] = await Promise.all([listConversations(user.id), listUserNumbers(user.id)]);
  const active = numbers.find((n) => n.status === "active");
  const [t, locale] = await Promise.all([getTranslations("messages"), getLocale()]);
  const tz = await viewerTimeZone();

  return (
    <div className="space-y-6">
      <AutoRefresh everyMs={10_000} />
      <PageHeader
        title={t("title")}
        description={t("description", { price: formatCents(config.pricing.smsInboundPerPartCents, locale) })}
      />

      {!config.features.inboundSms ? (
        <Notice>{t("smsOff")}</Notice>
      ) : !active ? (
        <Notice>
          {t.rich("getNumber", {
            link: (chunks) => (
              <Link href="/numbers" className="underline">
                {chunks}
              </Link>
            ),
          })}
        </Notice>
      ) : (
        !active.smsEnabledAt && <Notice>{t("smsSettingUp", { number: formatPhone(active.e164) })}</Notice>
      )}

      {conversations.length === 0 ? (
        <Empty>{t("empty")}</Empty>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-stone-100">
            {conversations.map((c) => (
              <li key={c.from}>
                <Link href={threadHref(c.from)} className="flex items-start justify-between gap-4 px-5 py-3 hover:bg-stone-50">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {/* Names run up to 60 characters, so they truncate instead of pushing past the card on phones. */}
                      <span className={`min-w-0 max-w-full truncate ${c.unread ? "font-semibold" : "font-medium"}`}>{c.name ?? formatPhone(c.from)}</span>
                      {c.name && <span className="whitespace-nowrap text-xs text-stone-500">{formatPhone(c.from)}</span>}
                      {c.unread > 0 && <span className="whitespace-nowrap"><Badge tone="blue">{t("newCount", { count: c.unread })}</Badge></span>}
                      {c.count > 1 && <span className="whitespace-nowrap text-xs text-stone-500">{t("textCount", { count: c.count })}</span>}
                    </div>
                    <p className={`mt-0.5 truncate text-sm ${c.unread ? "text-stone-800" : "text-stone-500"}`}>{messagePreview(c.last, t)}</p>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-xs text-stone-500 sm:text-sm">{formatDateTime(c.last.receivedAt, locale, tz)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
