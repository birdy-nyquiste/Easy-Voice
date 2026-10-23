import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardTitle, Empty, Field, Notice, PageHeader, StatusBadge, inputClass } from "@/components/ui";
import { config } from "@/lib/config";
import { formatCallerNumber, formatCents, formatDateTime, formatDuration, formatPhone } from "@/lib/format";
import { listUserAgents, MAX_CALL_GOAL_LENGTH } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { listUserCalls } from "@/server/calls";
import { isCallLive } from "@/server/calls/state";
import { listUserNumbers } from "@/server/numbers";
import { startCallAction } from "./actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { readVariables } from "@/lib/agent-settings";
import type { Agent } from "@/db/schema";
import { AgentFields, type CallAgent } from "./agent-fields";
import { viewerTimeZone } from "@/server/time-zone";

function callAgent(a: Agent): CallAgent {
  const ask = readVariables(a.variables).filter((v) => v.askPerCall);
  return { id: a.id, name: a.name, ask: ask.map(({ key, value }) => ({ key, value })) };
}

export default async function CallsPage() {
  const user = await requireUser();
  const [rows, agents, numbers] = await Promise.all([listUserCalls(user.id), listUserAgents(user.id), listUserNumbers(user.id)]);
  const readyAgents = agents.filter((a) => a.status === "ready");
  const activeNumber = numbers.find((n) => n.status === "active");
  const [t, tc, locale] = await Promise.all([getTranslations("calls"), getTranslations("common"), getLocale()]);
  const tz = await viewerTimeZone();
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
  const inFlight = rows.some(({ call }) => isCallLive(call));

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
            {/* The number's agent only if it's ready: an id not in the list would hide the shown agent's per-call fields. */}
            <AgentFields agents={readyAgents.map(callAgent)} defaultAgentId={readyAgents.find((a) => a.id === activeNumber.agentId)?.id ?? readyAgents[0].id}>
              <Field label={t("to")}>
                <input name="to" required inputMode="tel" placeholder="(415) 555-0100" className={inputClass} />
              </Field>
            </AgentFields>
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
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-stone-100 text-left text-xs font-medium text-stone-500">
              <tr>
                <th className="px-5 py-3 font-medium">{t("colCall")}</th>
                <th className="hidden px-3 py-3 font-medium sm:table-cell">{tc("agent")}</th>
                <th className="px-3 py-3 font-medium">{t("colStatus")}</th>
                <th className="hidden px-3 py-3 text-right font-medium sm:table-cell">{t("colDuration")}</th>
                <th className="hidden px-3 py-3 text-right font-medium sm:table-cell">{t("colCost")}</th>
                <th className="hidden px-5 py-3 text-right font-medium sm:table-cell">{t("colWhen")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map(({ call, agentName }) => (
                <tr key={call.id} className="hover:bg-stone-50">
                  <td className="px-5 py-3">
                    <Link href={`/calls/${call.id}`} className="flex items-center gap-2 whitespace-nowrap font-medium">
                      <Badge>{call.direction === "inbound" ? tc("inbound") : tc("outbound")}</Badge>
                      {formatCallerNumber(call.direction === "inbound" ? call.fromNumber : call.toNumber, tc("unknownNumber"))}
                    </Link>
                    {/* On phones the time goes here instead of in its own column. */}
                    <div className="mt-0.5 text-xs text-stone-500 sm:hidden">{formatDateTime(call.createdAt, locale, tz)}</div>
                  </td>
                  <td className="hidden px-3 py-3 text-stone-600 sm:table-cell">{agentName ?? "—"}</td>
                  <td className="px-3 py-3"><StatusBadge status={call.status} /></td>
                  <td className="hidden px-3 py-3 text-right tabular-nums sm:table-cell">{formatDuration(call.durationSec)}</td>
                  <td className="hidden px-3 py-3 text-right tabular-nums sm:table-cell">{call.billedCents != null ? formatCents(call.billedCents, locale) : "—"}</td>
                  <td className="hidden whitespace-nowrap px-5 py-3 text-right text-stone-500 sm:table-cell">{formatDateTime(call.createdAt, locale, tz)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
