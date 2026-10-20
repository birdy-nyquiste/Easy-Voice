import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardTitle, Empty, Field, Notice, PageHeader, StatusBadge, inputClass } from "@/components/ui";
import { config } from "@/lib/config";
import { formatCents, formatDateTime, formatDuration, formatPhone } from "@/lib/format";
import { listUserAgents, MAX_CALL_GOAL_LENGTH } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { listUserCalls } from "@/server/calls";
import { listUserNumbers } from "@/server/numbers";
import { startCallAction } from "./actions";
import { AutoRefresh } from "./auto-refresh";

export default async function CallsPage() {
  const user = await requireUser();
  const [rows, agents, numbers] = await Promise.all([listUserCalls(user.id), listUserAgents(user.id), listUserNumbers(user.id)]);
  const readyAgents = agents.filter((a) => a.status === "ready");
  const activeNumber = numbers.find((n) => n.status === "active");
  const [t, tc, locale] = await Promise.all([getTranslations("calls"), getTranslations("common"), getLocale()]);
  const numberLink = (chunks: React.ReactNode) => (
    <Link href="/numbers" className="underline">
      {chunks}
    </Link>
  );
  const agentLink = (chunks: React.ReactNode) => (
    <Link href="/agents/new" className="underline">
      {chunks}
    </Link>
  );
  const inFlight = rows.some(({ call }) => call.status === "initiated" || call.status === "answered");

  return (
    <div className="space-y-6">
      {inFlight && <AutoRefresh />}
      <PageHeader title={t("title")} description={t("description", { price: formatCents(config.pricing.callPerMinuteCents, locale) })} />

      <Card>
        <CardTitle>{t("placeTitle")}</CardTitle>
        {!activeNumber || readyAgents.length === 0 ? (
          <Notice>
            {t.rich(!activeNumber && readyAgents.length === 0 ? "needBoth" : !activeNumber ? "needNumber" : "needAgent", {
              number: numberLink,
              agent: agentLink,
            })}
          </Notice>
        ) : (
          <ActionForm action={startCallAction} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={tc("agent")}>
                <select name="agentId" defaultValue={activeNumber.agentId ?? readyAgents[0].id} className={inputClass}>
                  {readyAgents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </Field>
              <Field label={t("to")}>
                <input name="to" required inputMode="tel" placeholder="(415) 555-0100" className={inputClass} />
              </Field>
            </div>
            <Field
              label={t("goal")}
              hint={t.rich("goalHint", { code: (chunks) => <code>{chunks}</code> })}
            >
              <textarea
                name="goal"
                rows={2}
                maxLength={MAX_CALL_GOAL_LENGTH}
                placeholder={t("goalPlaceholder")}
                className={inputClass}
              />
            </Field>
            <SubmitButton pendingText={t("dialing")}>{t("call")}</SubmitButton>
          </ActionForm>
        )}
        <p className="mt-3 text-xs text-stone-500">
          {t("callerId", { number: activeNumber ? formatPhone(activeNumber.e164) : "" })}
        </p>
      </Card>

      {rows.length === 0 ? (
        <Empty>{t("empty")}</Empty>
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-stone-100 text-left text-xs font-medium text-stone-500">
              <tr>
                <th className="px-5 py-3 font-medium">{t("colCall")}</th>
                <th className="hidden px-3 py-3 font-medium sm:table-cell">{tc("agent")}</th>
                <th className="px-3 py-3 font-medium">{t("colStatus")}</th>
                <th className="hidden px-3 py-3 text-right font-medium sm:table-cell">{t("colDuration")}</th>
                <th className="hidden px-3 py-3 text-right font-medium sm:table-cell">{t("colCost")}</th>
                <th className="px-5 py-3 text-right font-medium">{t("colWhen")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map(({ call, agentName }) => (
                <tr key={call.id} className="hover:bg-stone-50">
                  <td className="px-5 py-3">
                    <Link href={`/calls/${call.id}`} className="flex items-center gap-2 whitespace-nowrap font-medium">
                      <Badge>{call.direction === "inbound" ? tc("inbound") : tc("outbound")}</Badge>
                      {formatPhone(call.direction === "inbound" ? call.fromNumber : call.toNumber)}
                    </Link>
                  </td>
                  <td className="hidden px-3 py-3 text-stone-600 sm:table-cell">{agentName ?? "—"}</td>
                  <td className="px-3 py-3"><StatusBadge status={call.status} /></td>
                  <td className="hidden px-3 py-3 text-right tabular-nums sm:table-cell">{formatDuration(call.durationSec)}</td>
                  <td className="hidden px-3 py-3 text-right tabular-nums sm:table-cell">{call.billedCents != null ? formatCents(call.billedCents, locale) : "—"}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-right text-stone-500">{formatDateTime(call.createdAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
