"use client";

import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { Field, inputClass } from "@/components/ui";
import { MAX_VARIABLE_VALUE_LENGTH } from "@/lib/agent-settings";

export interface CallAgent {
  id: string;
  name: string;
  /** The agent's ask-on-each-call variables, with their defaults. */
  ask: { key: string; value: string }[];
}

/**
 * The agent picker for a new call (beside `children`, the number field), then a field for each
 * variable the chosen agent asks for.
 */
export function AgentFields({ agents, defaultAgentId, children }: { agents: CallAgent[]; defaultAgentId: string; children: ReactNode }) {
  const t = useTranslations("calls");
  const tc = useTranslations("common");
  const [agentId, setAgentId] = useState(defaultAgentId);
  const ask = agents.find((a) => a.id === agentId)?.ask ?? [];
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tc("agent")}>
          <select name="agentId" value={agentId} onChange={(e) => setAgentId(e.target.value)} className={inputClass}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>
        {children}
      </div>
      {ask.map((v) => (
        <Field key={`${agentId}:${v.key}`} label={`{{${v.key}}}`} hint={v.value ? t("variableDefault", { value: v.value }) : undefined}>
          <input name={`var.${v.key}`} maxLength={MAX_VARIABLE_VALUE_LENGTH} placeholder={v.value} className={inputClass} />
        </Field>
      ))}
    </>
  );
}
