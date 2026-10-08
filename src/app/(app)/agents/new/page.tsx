import { Card, PageHeader } from "@/components/ui";
import { listModels } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { listStockVoices, listUserVoices } from "@/server/voices";
import { AgentForm } from "../agent-form";

export default async function NewAgentPage() {
  const user = await requireUser();
  const [stock, clones, models] = await Promise.all([
    listStockVoices(),
    listUserVoices(user.id),
    // Without the catalog the form still offers the default model.
    listModels().catch(() => []),
  ]);
  return (
    <div>
      <PageHeader title="New agent" />
      <Card>
        <AgentForm stock={stock} clones={clones} models={models} />
      </Card>
    </div>
  );
}
