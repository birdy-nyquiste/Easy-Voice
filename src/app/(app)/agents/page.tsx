import Link from "next/link";
import { ButtonLink, Card, Empty, PageHeader, StatusBadge } from "@/components/ui";
import { config } from "@/lib/config";
import { formatPhone } from "@/lib/format";
import { listUserAgents } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { listUserNumbers } from "@/server/numbers";

export default async function AgentsPage() {
  const user = await requireUser();
  const [agents, numbers] = await Promise.all([listUserAgents(user.id), listUserNumbers(user.id)]);
  return (
    <div>
      <PageHeader
        title="Agents"
        description="An agent answers and places calls with the voice and instructions you give it."
        action={agents.length < config.limits.agentsPerUser && <ButtonLink href="/agents/new">New agent</ButtonLink>}
      />
      {agents.length === 0 ? (
        <Empty>No agents yet. <Link href="/agents/new" className="font-medium underline">Create your first agent</Link>.</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {agents.map((a) => {
            const num = numbers.find((n) => n.agentId === a.id && n.status === "active");
            return (
              <Link key={a.id} href={`/agents/${a.id}`}>
                <Card className="transition hover:border-stone-400">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{a.name}</span>
                    <StatusBadge status={a.status} />
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-stone-500">{a.greeting}</p>
                  <p className="mt-3 text-xs text-stone-500">
                    {a.language === "zh" ? "Mandarin" : "English"} · {num ? `Answers ${formatPhone(num.e164)}` : "Not on a number"}
                  </p>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
