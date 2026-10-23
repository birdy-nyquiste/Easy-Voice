import { getLocale, getTranslations } from "next-intl/server";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardTitle, Field, Notice, StatusBadge, inputClass } from "@/components/ui";
import type { Agent } from "@/db/schema";
import { config } from "@/lib/config";
import { errorText } from "@/lib/errors";
import { formatCents, formatMegabytes, formatNumber, toMegabytes } from "@/lib/format";
import { showStored } from "@/lib/stored-text";
import { countUserSources, getAgentKnowledge } from "@/server/knowledge";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  addKnowledgeFileAction,
  addKnowledgeTextAction,
  addKnowledgeUrlAction,
  deleteKnowledgeSourceAction,
  setKnowledgeModeAction,
} from "./knowledge-actions";
import { KnowledgeFileInput } from "./knowledge-file-input";

/** The agent's knowledge base: how it's used, its sources, and forms to add more (SPEC §18). */
export async function KnowledgeSection({ agent }: { agent: Agent }) {
  const [{ base, sources, website, notApplied, notRemoved }, used, t, locale] = await Promise.all([
    getAgentKnowledge(agent),
    countUserSources(agent.userId),
    getTranslations("knowledge"),
    getLocale(),
  ]);
  const price = formatCents(config.pricing.knowledgeSourceCents, locale);
  const max = config.limits.knowledgeSources;
  const full = used >= max;
  const usesIt = base && base.mode !== "off";
  const pending = sources.some((s) => s.status === "processing");
  const typeLabel = { text: t("typeText"), file: t("typeFile"), url: t("typeUrl") };
  // A new key after each add remounts the forms, which clears what was typed. It also drops the
  // form's message, so adds show none: the new row is the confirmation.
  const formKey = sources.map((s) => s.id).join();

  return (
    <Card>
      {/* A deleted website goes once its crawl is quiet, which page visits check; slowly, as that takes a while. */}
      {pending ? <AutoRefresh /> : website === "removing" && <AutoRefresh everyMs={60_000} />}
      <CardTitle>{t("title")}</CardTitle>
      <div className="space-y-4">
        <p className="text-sm text-stone-600">{t("intro", { price })}</p>
        <p className="text-xs text-stone-500">{t("privacy")}</p>

        {notApplied && <Notice>{t("notApplied")}</Notice>}
        {notRemoved && <Notice>{t("notRemoved")}</Notice>}
        {website === "removing" && <Notice>{t("websiteRemoving")}</Notice>}
        {usesIt && !pending && !sources.some((s) => s.status === "ready") && <Notice>{t("noUsable")}</Notice>}

        {base && (
          <ActionForm action={setKnowledgeModeAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="agentId" value={agent.id} />
            <div className="min-w-64 flex-1">
              <Field label={t("mode")}>
                <select name="mode" defaultValue={base.mode} className={inputClass}>
                  <option value="reference">{t("modeReference")}</option>
                  <option value="strict">{t("modeStrict")}</option>
                  <option value="off">{t("modeOff")}</option>
                </select>
              </Field>
            </div>
            <SubmitButton variant="secondary">{t("saveMode")}</SubmitButton>
          </ActionForm>
        )}

        {sources.length === 0 ? (
          <p className="text-sm text-stone-500">{t("empty")}</p>
        ) : (
          <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
            {sources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                {/* On phones the name gets a line of its own; a name that is still cut off shows in full on hover. */}
                <div className="min-w-0 grow basis-full sm:basis-0">
                  <p className="flex min-w-0 items-center gap-2">
                    <Badge>{typeLabel[s.type]}</Badge>
                    {s.type === "url" && s.url ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={s.url}
                        className="truncate font-medium text-stone-800 hover:underline"
                      >
                        {s.name}
                      </a>
                    ) : (
                      <span title={s.name ?? undefined} className="truncate font-medium text-stone-800">
                        {s.name}
                      </span>
                    )}
                  </p>
                  {s.status === "failed" && <p className="text-xs text-red-600">{showStored(locale, s.failureReason, s.failureMsg)}</p>}
                  {/* Small sources would read "0 MB". */}
                  {s.status === "ready" && s.sizeBytes !== null && s.sizeBytes >= 100 * 1024 && (
                    <p className="text-xs text-stone-500">{formatMegabytes(s.sizeBytes, locale)}</p>
                  )}
                  {s.type === "text" && s.content && (
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer text-stone-500">{t("showText")}</summary>
                      <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-stone-50 p-2 text-stone-700">
                        {s.content}
                      </p>
                    </details>
                  )}
                </div>
                <StatusBadge status={s.status === "deleting" ? "processing" : s.status} />
                <ActionForm action={deleteKnowledgeSourceAction}>
                  <input type="hidden" name="agentId" value={agent.id} />
                  <input type="hidden" name="sourceId" value={s.id} />
                  <SubmitButton variant="danger" confirm={t("deleteConfirm")}>
                    {t("delete")}
                    <span className="sr-only"> {s.name}</span>
                  </SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-stone-500">{t("usage", { count: used, max })}</p>

        {!full && (
          <div className="space-y-2" key={formKey}>
            <details className="rounded-lg border border-stone-200 px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium text-stone-700">{t("addText")}</summary>
              <ActionForm action={addKnowledgeTextAction} className="mt-3 space-y-3">
                <input type="hidden" name="agentId" value={agent.id} />
                <Field label={t("titleLabel")}>
                  <input name="title" required maxLength={80} className={inputClass} />
                </Field>
                <Field label={t("textLabel")} hint={t("textHint", { max: formatNumber(config.limits.knowledgeTextChars, locale) })}>
                  <textarea name="text" required rows={6} maxLength={config.limits.knowledgeTextChars} className={inputClass} />
                </Field>
                <SubmitButton>{t("addFor", { price })}</SubmitButton>
              </ActionForm>
            </details>
            <details className="rounded-lg border border-stone-200 px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium text-stone-700">{t("addFile")}</summary>
              <ActionForm action={addKnowledgeFileAction} className="mt-3 space-y-3">
                <input type="hidden" name="agentId" value={agent.id} />
                <Field
                  label={t("addFile")}
                  hint={t("fileHint", {
                    chars: formatNumber(config.limits.knowledgeFileChars, locale),
                    size: formatNumber(toMegabytes(config.limits.knowledgePdfBytes), locale),
                  })}
                >
                  {(control) => (
                    <KnowledgeFileInput
                      control={control}
                      maxPdfBytes={config.limits.knowledgePdfBytes}
                      maxChars={config.limits.knowledgeFileChars}
                      tooLarge={errorText(locale, "knowledgeFileTooLarge", { size: toMegabytes(config.limits.knowledgePdfBytes) })}
                      tooLong={errorText(locale, "knowledgeFileTooLong", { max: config.limits.knowledgeFileChars })}
                    />
                  )}
                </Field>
                <SubmitButton>{t("addFor", { price })}</SubmitButton>
              </ActionForm>
            </details>
            {/* One website per agent, counting one that is still being removed. */}
            {config.features.knowledgeUrls && !website && (
              <details className="rounded-lg border border-stone-200 px-4 py-3">
                <summary className="cursor-pointer text-sm font-medium text-stone-700">{t("addUrl")}</summary>
                <ActionForm action={addKnowledgeUrlAction} className="mt-3 space-y-3">
                  <input type="hidden" name="agentId" value={agent.id} />
                  <Field label={t("urlLabel")} hint={t("urlHint", { size: formatNumber(toMegabytes(config.limits.knowledgeCrawlBytes), locale) })}>
                    <input name="url" type="url" required placeholder="https://" className={inputClass} />
                  </Field>
                  <SubmitButton>{t("addFor", { price })}</SubmitButton>
                </ActionForm>
              </details>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
