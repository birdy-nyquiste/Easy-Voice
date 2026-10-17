import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardTitle, Notice, PageHeader, StatusBadge } from "@/components/ui";
import { formatCents, formatDateTime, formatDuration, formatPhone } from "@/lib/format";
import { showStored } from "@/lib/stored-text";
import { getUserAgent } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { getUserCall } from "@/server/calls";
import { deleteCallAction, hangupAction } from "../actions";
import { AutoRefresh } from "../auto-refresh";

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const call = await getUserCall(user.id, id);
  if (!call) notFound();
  const agent = call.agentId ? await getUserAgent(user.id, call.agentId) : null;
  const live = !call.endedAt;
  const awaitingResults = call.status === "completed" && !call.resultsFetched;
  const [t, tc, locale] = await Promise.all([getTranslations("calls"), getTranslations("common"), getLocale()]);
  const other = call.direction === "inbound" ? call.fromNumber : call.toNumber;

  return (
    <div className="space-y-6">
      {(live || awaitingResults) && <AutoRefresh everyMs={live ? 1500 : 4000} />}
      <PageHeader
        back={{ href: "/calls", label: t("all") }}
        title={t(call.direction === "inbound" ? "from" : "toTitle", { number: formatPhone(other) })}
        description={formatDateTime(call.createdAt, locale)}
        action={<StatusBadge status={call.status} />}
      />

      {live && (
        <Notice tone="blue">
          <div className="flex items-center justify-between gap-3">
            <span>{call.status === "answered" ? t("inProgress") : t("connecting")}</span>
            <ActionForm action={hangupAction}>
              <input type="hidden" name="id" value={call.id} />
              <SubmitButton variant="danger">{t("hangUp")}</SubmitButton>
            </ActionForm>
          </div>
        </Notice>
      )}
      {call.goal && (
        <Card>
          <CardTitle>{t("goalTitle")}</CardTitle>
          <p className="whitespace-pre-wrap text-sm text-stone-700">{call.goal}</p>
        </Card>
      )}
      {call.outcome && (
        <Notice tone={call.status === "completed" ? "amber" : "red"}>{showStored(locale, call.outcome, call.outcomeMsg)}</Notice>
      )}

      <Card>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div><dt className="text-stone-500">{t("direction")}</dt><dd className="mt-1"><Badge>{t(call.direction === "inbound" ? "directionInbound" : "directionOutbound")}</Badge></dd></div>
          <div><dt className="text-stone-500">{tc("agent")}</dt><dd className="mt-1 font-medium">{agent?.name ?? "—"}</dd></div>
          <div><dt className="text-stone-500">{t("colDuration")}</dt><dd className="mt-1 font-medium tabular-nums">{formatDuration(call.durationSec)}</dd></div>
          <div><dt className="text-stone-500">{t("colCost")}</dt><dd className="mt-1 font-medium tabular-nums">{call.billedCents != null ? formatCents(call.billedCents) : "—"}</dd></div>
        </dl>
      </Card>

      {call.status === "completed" && (
        <>
          <Card>
            <CardTitle>{t("summary")}</CardTitle>
            <p className="text-sm text-stone-700">{call.summary ?? (awaitingResults ? t("generating") : t("noSummary"))}</p>
          </Card>
          {call.hasRecording && (
            <Card>
              <CardTitle>{t("recording")}</CardTitle>
              <audio controls preload="none" src={`/api/calls/${call.id}/recording`} className="w-full" />
            </Card>
          )}
          <Card>
            <CardTitle>{t("transcript")}</CardTitle>
            {call.transcript?.length ? (
              <ol className="space-y-3">
                {call.transcript.map((m, i) => (
                  <li key={i} className={`flex ${m.role === "assistant" ? "" : "justify-end"}`}>
                    <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${m.role === "assistant" ? "bg-stone-100" : "bg-stone-900 text-white"}`}>
                      <div className="mb-0.5 text-xs opacity-60">{m.role === "assistant" ? agent?.name ?? tc("agent") : t("caller")}</div>
                      {m.text}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-stone-500">{awaitingResults ? t("fetchingTranscript") : t("noTranscript")}</p>
            )}
          </Card>
        </>
      )}

      {!live && (
        <ActionForm action={deleteCallAction}>
          <input type="hidden" name="id" value={call.id} />
          <SubmitButton variant="danger" confirm={t("deleteConfirm")}>
            {t("delete")}
          </SubmitButton>
        </ActionForm>
      )}
    </div>
  );
}
