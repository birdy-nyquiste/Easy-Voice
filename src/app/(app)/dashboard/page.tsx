import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Badge, Card, CardTitle, StatusBadge } from "@/components/ui";
import { formatCents, formatDateTime, formatDuration, formatPhone } from "@/lib/format";
import { listUserAgents } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { listUserCalls } from "@/server/calls";
import { listUserNumbers } from "@/server/numbers";

export default async function DashboardPage() {
  const user = await requireUser();
  const [t, tc, locale] = await Promise.all([getTranslations("dashboard"), getTranslations("common"), getLocale()]);
  const [numbers, agents, recent] = await Promise.all([
    listUserNumbers(user.id),
    listUserAgents(user.id),
    listUserCalls(user.id, 5),
  ]);
  const activeNumber = numbers.find((n) => n.status === "active");
  const linkedAgent = agents.find((a) => a.id === activeNumber?.agentId);

  const steps = [
    { done: user.balanceCents > 0, label: t("stepCredit"), href: "/account/billing" },
    { done: agents.some((a) => a.status === "ready"), label: t("stepAgent"), href: "/agents/new" },
    { done: Boolean(activeNumber), label: t("stepNumber"), href: "/numbers" },
    { done: Boolean(linkedAgent), label: t("stepConnect"), href: "/numbers" },
    { done: recent.length > 0, label: t("stepCall"), href: "/calls" },
  ];
  const allDone = steps.every((s) => s.done);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardTitle>{t("balance")}</CardTitle>
          <p className={`text-2xl font-semibold ${user.balanceCents <= 0 ? "text-red-600" : ""}`}>{formatCents(user.balanceCents)}</p>
          <Link href="/account/billing" className="mt-1 inline-block text-sm text-stone-500 hover:text-stone-900">{t("topUp")}</Link>
        </Card>
        <Card>
          <CardTitle>{t("number")}</CardTitle>
          <p className="text-2xl font-semibold">{activeNumber ? formatPhone(activeNumber.e164) : "—"}</p>
          <p className="mt-1 text-sm text-stone-500">{linkedAgent ? t("answeredBy", { name: linkedAgent.name }) : activeNumber ? t("noAgent") : t("noNumber")}</p>
        </Card>
        <Card>
          <CardTitle>{t("agents")}</CardTitle>
          <p className="text-2xl font-semibold">{agents.length}</p>
          <Link href="/agents" className="mt-1 inline-block text-sm text-stone-500 hover:text-stone-900">{t("manage")}</Link>
        </Card>
      </div>

      {!allDone && (
        <Card>
          <CardTitle>{t("setup")}</CardTitle>
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={s.label} className="flex items-center gap-3 text-sm">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${s.done ? "bg-emerald-600 text-white" : "bg-stone-100 text-stone-500"}`}>
                  {s.done ? "✓" : i + 1}
                </span>
                {s.done ? (
                  <span className="text-stone-400 line-through">{s.label}</span>
                ) : (
                  <Link href={s.href} className="font-medium hover:underline">{s.label}</Link>
                )}
              </li>
            ))}
          </ol>
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between">
          <CardTitle>{t("recentCalls")}</CardTitle>
          <Link href="/calls" className="text-sm text-stone-500 hover:text-stone-900">{t("allCalls")}</Link>
        </div>
        {recent.length === 0 ? (
          <p className="text-sm text-stone-500">{t("noCalls")}</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {recent.map(({ call, agentName }) => (
              <li key={call.id}>
                <Link href={`/calls/${call.id}`} className="flex items-center justify-between gap-3 py-2.5 text-sm hover:bg-stone-50">
                  <span className="flex items-center gap-2">
                    <Badge>{call.direction === "inbound" ? tc("inbound") : tc("outbound")}</Badge>
                    {formatPhone(call.direction === "inbound" ? call.fromNumber : call.toNumber)}
                    <span className="text-stone-400">· {agentName ?? "—"}</span>
                  </span>
                  <span className="flex items-center gap-3 text-stone-500">
                    {formatDuration(call.durationSec)}
                    <StatusBadge status={call.status} />
                    <span className="hidden sm:inline">{formatDateTime(call.createdAt, locale)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
