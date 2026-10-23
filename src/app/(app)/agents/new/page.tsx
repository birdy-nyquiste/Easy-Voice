import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Empty, PageHeader } from "@/components/ui";
import { AGENT_TEMPLATES, offeredTemplates, toTemplateId } from "@/lib/agent-templates";
import { config } from "@/lib/config";
import { listModels, listUserAgents } from "@/server/agents";
import { requireUser } from "@/server/auth";
import { listStockVoices, listUserVoices } from "@/server/voices";
import { AgentForm } from "../agent-form";

/** Pick a template first; the form then starts from it (?template=<id>). */
export default async function NewAgentPage({ searchParams }: { searchParams: Promise<{ template?: string }> }) {
  const user = await requireUser();
  const [t, tt, agents] = await Promise.all([getTranslations("agents"), getTranslations("agentTemplates"), listUserAgents(user.id)]);

  // Saving would be refused at the limit: say so before the form is filled in.
  const max = config.limits.agentsPerUser;
  if (agents.length >= max) {
    return (
      <div>
        <PageHeader back={{ href: "/agents", label: t("all") }} title={t("new")} />
        <Empty>{t("limitReached", { max })}</Empty>
      </div>
    );
  }

  const offered = offeredTemplates(config.features.knowledgeBase);
  const requested = toTemplateId((await searchParams).template);
  const templateId = requested && offered.includes(requested) ? requested : null;

  if (!templateId) {
    return (
      <div>
        <PageHeader back={{ href: "/agents", label: t("all") }} title={t("new")} description={tt("pick")} />
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {offered.map((id) => (
            <li key={id}>
              <Link
                href={`/agents/new?template=${id}`}
                className="block h-full rounded-xl border border-stone-200 bg-white p-4 shadow-sm transition hover:border-stone-400 hover:shadow"
              >
                <span className="block text-sm font-semibold text-stone-900">{tt(`${id}.name`)}</span>
                <span className="mt-1 block text-sm text-stone-500">{tt(`${id}.description`)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const [stock, clones, models] = await Promise.all([
    // Without the catalog the form says why there are no built-in voices.
    listStockVoices().catch((err) => {
      console.error("voice catalog unavailable", err);
      return null;
    }),
    listUserVoices(user.id),
    // Without the catalog the form still offers the default model.
    listModels().catch(() => []),
  ]);
  return (
    <div>
      <PageHeader
        back={{ href: "/agents", label: t("all") }}
        title={t("new")}
        description={tt("startingFrom", { name: tt(`${templateId}.name`) })}
        action={
          <Link href="/agents/new" className="text-sm font-medium text-stone-600 underline">
            {tt("change")}
          </Link>
        }
      />
      <AgentForm
        template={AGENT_TEMPLATES[templateId]}
        templateName={templateId === "blank" ? "" : tt(`${templateId}.name`)}
        stock={stock}
        clones={clones}
        models={models}
      />
    </div>
  );
}
