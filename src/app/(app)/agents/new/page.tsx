import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui";
import { listModels } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { listStockVoices, listUserVoices } from "@/server/voices";
import { AgentForm } from "../agent-form";

export default async function NewAgentPage() {
  const user = await requireUser();
  const t = await getTranslations("agents");
  const [stock, clones, models] = await Promise.all([
    listStockVoices(),
    listUserVoices(user.id),
    // Without the catalog the form still offers the default model.
    listModels().catch(() => []),
  ]);
  return (
    <div>
      <PageHeader back={{ href: "/agents", label: t("all") }} title={t("new")} />
      <Card>
        <AgentForm stock={stock} clones={clones} models={models} />
      </Card>
    </div>
  );
}
