import Link from "next/link";
import { Badge, Card, CardTitle, StatusBadge } from "@/components/ui";
import { formatCents, formatDateTime, formatDuration, formatPhone } from "@/lib/format";
import { listUserAgents } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { listUserCalls } from "@/server/calls";
import { listUserNumbers } from "@/server/numbers";

export default async function DashboardPage() {
  const user = await requireUser();
  const [numbers, agents, recent] = await Promise.all([
    listUserNumbers(user.id),
    listUserAgents(user.id),
    listUserCalls(user.id, 5),
  ]);
  const activeNumber = numbers.find((n) => n.status === "active");
  const linkedAgent = agents.find((a) => a.id === activeNumber?.agentId);

  const steps = [
    { done: user.balanceCents > 0, label: "Add credit", href: "/billing" },
    { done: agents.some((a) => a.status === "ready"), label: "Create an agent (pick or clone a voice)", href: "/agents/new" },
    { done: Boolean(activeNumber), label: "Get a phone number", href: "/numbers" },
    { done: Boolean(linkedAgent), label: "Connect the agent to your number", href: "/numbers" },
    { done: recent.length > 0, label: "Make or receive your first call", href: "/calls" },
  ];
  const allDone = steps.every((s) => s.done);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardTitle>Balance</CardTitle>
          <p className={`text-2xl font-semibold ${user.balanceCents <= 0 ? "text-red-600" : ""}`}>{formatCents(user.balanceCents)}</p>
          <Link href="/billing" className="mt-1 inline-block text-sm text-stone-500 hover:text-stone-900">Top up →</Link>
        </Card>
        <Card>
          <CardTitle>Number</CardTitle>
          <p className="text-2xl font-semibold">{activeNumber ? formatPhone(activeNumber.e164) : "—"}</p>
          <p className="mt-1 text-sm text-stone-500">{linkedAgent ? `Answered by ${linkedAgent.name}` : activeNumber ? "No agent assigned" : "No number yet"}</p>
        </Card>
        <Card>
          <CardTitle>Agents</CardTitle>
          <p className="text-2xl font-semibold">{agents.length}</p>
          <Link href="/agents" className="mt-1 inline-block text-sm text-stone-500 hover:text-stone-900">Manage →</Link>
        </Card>
      </div>

      {!allDone && (
        <Card>
          <CardTitle>Get set up</CardTitle>
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
          <CardTitle>Recent calls</CardTitle>
          <Link href="/calls" className="text-sm text-stone-500 hover:text-stone-900">All calls →</Link>
        </div>
        {recent.length === 0 ? (
          <p className="text-sm text-stone-500">No calls yet.</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {recent.map(({ call, agentName }) => (
              <li key={call.id}>
                <Link href={`/calls/${call.id}`} className="flex items-center justify-between gap-3 py-2.5 text-sm hover:bg-stone-50">
                  <span className="flex items-center gap-2">
                    <Badge>{call.direction === "inbound" ? "↙ in" : "↗ out"}</Badge>
                    {formatPhone(call.direction === "inbound" ? call.fromNumber : call.toNumber)}
                    <span className="text-stone-400">· {agentName ?? "—"}</span>
                  </span>
                  <span className="flex items-center gap-3 text-stone-500">
                    {formatDuration(call.durationSec)}
                    <StatusBadge status={call.status} />
                    <span className="hidden sm:inline">{formatDateTime(call.createdAt)}</span>
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
