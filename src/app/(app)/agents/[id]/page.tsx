import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardTitle, Notice, PageHeader, StatusBadge } from "@/components/ui";
import { getUserAgent } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { listStockVoices, listUserVoices } from "@/server/voices";
import { deleteAgentAction } from "../actions";
import { AgentForm } from "../agent-form";

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const agent = await getUserAgent(user.id, id);
  if (!agent) notFound();
  const [stock, clones] = await Promise.all([listStockVoices(), listUserVoices(user.id)]);
  return (
    <div className="space-y-6">
      <PageHeader title={agent.name} action={<StatusBadge status={agent.status} />} />
      {agent.status === "failed" && <Notice tone="red">{agent.failureReason}</Notice>}
      <Card>
        <AgentForm agent={agent} stock={stock} clones={clones} />
      </Card>
      <Card>
        <CardTitle>Danger zone</CardTitle>
        <ActionForm action={deleteAgentAction}>
          <input type="hidden" name="id" value={agent.id} />
          <SubmitButton variant="danger" confirm={`Delete ${agent.name}? Its number will stop answering calls.`}>
            Delete agent
          </SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
