import { Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/server/auth";
import { listStockVoices, listUserVoices } from "@/server/voices";
import { AgentForm } from "../agent-form";

export default async function NewAgentPage() {
  const user = await requireUser();
  const [stock, clones] = await Promise.all([listStockVoices(), listUserVoices(user.id)]);
  return (
    <div>
      <PageHeader title="New agent" />
      <Card>
        <AgentForm stock={stock} clones={clones} />
      </Card>
    </div>
  );
}
