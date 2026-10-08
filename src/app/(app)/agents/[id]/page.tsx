import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardTitle, Notice, PageHeader, StatusBadge } from "@/components/ui";
import { getUserAgent, listModels } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { listStockVoices, listUserVoices } from "@/server/voices";
import { deleteAgentAction } from "../actions";
import { AgentForm } from "../agent-form";

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { saved } = await searchParams;
  const agent = await getUserAgent(user.id, id);
  if (!agent) notFound();
  const [stock, clones, models] = await Promise.all([
    listStockVoices(),
    listUserVoices(user.id),
    // Without the catalog the form still offers the default model.
    listModels().catch(() => []),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader title={agent.name} action={<StatusBadge status={agent.status} />} />
      {agent.status === "failed" && <Notice tone="red">{agent.failureReason}</Notice>}
      {saved && agent.status === "ready" && <Notice tone="green">Saved.</Notice>}
      <Card>
        {/* Keyed on updatedAt: React resets a form to its initial defaults after an action, so
            without a remount the fields would show pre-save values (and a second save would revert). */}
        <AgentForm key={agent.updatedAt.toISOString()} agent={agent} stock={stock} clones={clones} models={models} />
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
