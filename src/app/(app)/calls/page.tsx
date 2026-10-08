import Link from "next/link";
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
  const inFlight = rows.some(({ call }) => call.status === "initiated" || call.status === "answered");

  return (
    <div className="space-y-6">
      {inFlight && <AutoRefresh />}
      <PageHeader title="Calls" description={`Calls are billed at ${formatCents(config.pricing.callPerMinuteCents)}/min, rounded up.`} />

      <Card>
        <CardTitle>Have your agent call someone</CardTitle>
        {!activeNumber || readyAgents.length === 0 ? (
          <Notice>
            You need {!activeNumber && <Link href="/numbers" className="underline">an active number</Link>}
            {!activeNumber && readyAgents.length === 0 && " and "}
            {readyAgents.length === 0 && <Link href="/agents/new" className="underline">a ready agent</Link>} to place calls.
          </Notice>
        ) : (
          <ActionForm action={startCallAction} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Agent">
                <select name="agentId" defaultValue={activeNumber.agentId ?? readyAgents[0].id} className={inputClass}>
                  {readyAgents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Number to call">
                <input name="to" required inputMode="tel" placeholder="(415) 555-0100" className={inputClass} />
              </Field>
            </div>
            <Field
              label="What should the agent do on this call? (optional)"
              hint={<>Passed to the agent as <code>{"{{call_goal}}"}</code> for this call only. Its instructions decide how to use it.</>}
            >
              <textarea
                name="goal"
                rows={2}
                maxLength={MAX_CALL_GOAL_LENGTH}
                placeholder="e.g. Call Dr. Lee's office and move my Thursday 3pm appointment to next week."
                className={inputClass}
              />
            </Field>
            <SubmitButton pendingText="Dialing…">Call</SubmitButton>
          </ActionForm>
        )}
        <p className="mt-3 text-xs text-stone-500">Calls show your number {activeNumber ? formatPhone(activeNumber.e164) : ""} as caller ID. Only call people who expect to hear from your assistant.</p>
      </Card>

      {rows.length === 0 ? (
        <Empty>No calls yet.</Empty>
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-stone-100 text-left text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-5 py-3 font-medium">Call</th>
                <th className="hidden px-3 py-3 font-medium sm:table-cell">Agent</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="hidden px-3 py-3 text-right font-medium sm:table-cell">Duration</th>
                <th className="hidden px-3 py-3 text-right font-medium sm:table-cell">Cost</th>
                <th className="px-5 py-3 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map(({ call, agentName }) => (
                <tr key={call.id} className="hover:bg-stone-50">
                  <td className="px-5 py-3">
                    <Link href={`/calls/${call.id}`} className="flex items-center gap-2 whitespace-nowrap font-medium">
                      <Badge>{call.direction === "inbound" ? "↙ in" : "↗ out"}</Badge>
                      {formatPhone(call.direction === "inbound" ? call.fromNumber : call.toNumber)}
                    </Link>
                  </td>
                  <td className="hidden px-3 py-3 text-stone-600 sm:table-cell">{agentName ?? "—"}</td>
                  <td className="px-3 py-3"><StatusBadge status={call.status} /></td>
                  <td className="hidden px-3 py-3 text-right tabular-nums sm:table-cell">{formatDuration(call.durationSec)}</td>
                  <td className="hidden px-3 py-3 text-right tabular-nums sm:table-cell">{call.billedCents != null ? formatCents(call.billedCents) : "—"}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-right text-stone-500">{formatDateTime(call.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
