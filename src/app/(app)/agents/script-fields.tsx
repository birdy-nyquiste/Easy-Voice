"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { buttonClass, inputClass } from "@/components/ui";
import {
  BUILT_IN_VARIABLES,
  isTimeZone,
  MAX_VARIABLE_KEY_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  MAX_VARIABLES,
  undefinedVariables,
  variableKeyProblem,
  type AgentVariable,
} from "@/lib/agent-settings";

type Row = AgentVariable & { id: number };
type TextField = HTMLInputElement | HTMLTextAreaElement;

/**
 * Greeting, instructions and the variables they can use. Variables are edited here, next to the
 * text that uses them, and posted as one JSON field.
 */
export function ScriptFields({
  greeting,
  instructions,
  variables,
  timeZone,
  guessTimeZone,
  greetingHint,
}: {
  greeting: string;
  instructions: string;
  variables: AgentVariable[];
  timeZone: string;
  /** New agents start in the browser's time zone. */
  guessTimeZone: boolean;
  greetingHint: string;
}) {
  const t = useTranslations("agents");
  const greetingRef = useRef<HTMLInputElement>(null);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(variables.length);
  const [rows, setRows] = useState<Row[]>(() => variables.map((v, id) => ({ ...v, id })));
  // Tracked only to warn, as the user types, about {{names}} that nothing fills in.
  const [texts, setTexts] = useState({ greeting, instructions });
  const unfilled = undefinedVariables([texts.greeting, texts.instructions], rows);
  const [tz, setTz] = useState(timeZone);
  // The zone list differs between runtimes, so it's filled in after hydration.
  const [zones, setZones] = useState([timeZone]);
  useEffect(() => {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const start = guessTimeZone && browser && isTimeZone(browser) ? browser : timeZone;
    setTz(start);
    setZones(timeZones(start));
  }, [guessTimeZone, timeZone]);

  const names = [...BUILT_IN_VARIABLES, ...rows.map((r) => r.key.trim()).filter((k) => k && !variableKeyProblem(k))];
  const update = (id: number, patch: Partial<AgentVariable>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const ids = { greeting: useId(), instructions: useId() };

  return (
    <>
      <div className="space-y-1.5">
        <LabelRow htmlFor={ids.greeting} label={t("greeting")} insert={<InsertVariable names={names} target={greetingRef} />} />
        <input
          id={ids.greeting}
          ref={greetingRef}
          name="greeting"
          required
          maxLength={500}
          defaultValue={greeting}
          onInput={(e) => {
            const value = e.currentTarget.value;
            setTexts((x) => ({ ...x, greeting: value }));
          }}
          placeholder={t("greetingPlaceholder")}
          className={inputClass}
        />
        <span className="block text-xs text-stone-500">{greetingHint}</span>
      </div>

      <div className="space-y-1.5">
        <LabelRow htmlFor={ids.instructions} label={t("instructions")} insert={<InsertVariable names={names} target={instructionsRef} />} />
        <textarea
          id={ids.instructions}
          ref={instructionsRef}
          name="instructions"
          required
          rows={10}
          maxLength={8000}
          defaultValue={instructions}
          onInput={(e) => {
            const value = e.currentTarget.value;
            setTexts((x) => ({ ...x, instructions: value }));
          }}
          placeholder={t("instructionsPlaceholder")}
          className={`${inputClass} font-mono text-xs leading-relaxed`}
        />
        <span className="block text-xs text-stone-500">{t("instructionsHint")}</span>
      </div>

      <div className="space-y-3">
        <div>
          <span className="text-sm font-medium text-stone-700">{t("variables")}</span>
          <span className="block text-xs text-stone-500">{t.rich("variablesHint", { code: (c) => <code>{c}</code> })}</span>
        </div>
        {unfilled.length > 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t("undefinedVariables", { names: unfilled.map((n) => `{{${n}}}`).join(", ") })}
          </p>
        )}
        <dl className="divide-y divide-stone-100 rounded-lg border border-stone-200 text-sm">
          {BUILT_IN_VARIABLES.map((name) => (
            <div key={name} className="grid gap-1 px-3 py-2 sm:grid-cols-[11rem_1fr]">
              <dt className="font-mono text-xs leading-5 text-stone-700">{`{{${name}}}`}</dt>
              <dd className="text-stone-500">{t(`builtIn.${name}`)}</dd>
            </div>
          ))}
        </dl>

        {rows.length > 0 && (
          <div className="space-y-2">
            <div className="hidden gap-2 px-0.5 text-xs font-medium text-stone-500 sm:grid sm:grid-cols-[11rem_1fr_auto_auto]">
              <span>{t("variableName")}</span>
              <span>{t("variableValue")}</span>
              <span>{t("askPerCall")}</span>
              <span className="w-16" />
            </div>
            {rows.map((r) => (
              <div key={r.id} className="grid items-center gap-2 sm:grid-cols-[11rem_1fr_auto_auto]">
                <input
                  aria-label={t("variableName")}
                  value={r.key}
                  onChange={(e) => update(r.id, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
                  placeholder="owner_name"
                  maxLength={MAX_VARIABLE_KEY_LENGTH}
                  className={`${inputClass} font-mono text-xs`}
                />
                <input
                  aria-label={t("variableValue")}
                  value={r.value}
                  onChange={(e) => update(r.id, { value: e.target.value })}
                  placeholder={r.askPerCall ? t("variableValueOptional") : t("variableValuePlaceholder")}
                  required={!r.askPerCall}
                  maxLength={MAX_VARIABLE_VALUE_LENGTH}
                  className={inputClass}
                />
                <label className="flex items-center gap-2 text-sm text-stone-600 sm:justify-center">
                  <input
                    type="checkbox"
                    checked={r.askPerCall}
                    onChange={(e) => update(r.id, { askPerCall: e.target.checked })}
                    className="h-4 w-4 accent-stone-900"
                  />
                  <span className="sm:sr-only">{t("askPerCall")}</span>
                </label>
                <button
                  type="button"
                  onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
                  className="w-16 rounded-md px-2 py-1 text-xs font-medium text-stone-600 hover:bg-stone-100"
                >
                  {t("removeVariable")}
                </button>
              </div>
            ))}
            <span className="block text-xs text-stone-500">{t("askPerCallHint")}</span>
          </div>
        )}
        <button
          type="button"
          disabled={rows.length >= MAX_VARIABLES}
          onClick={() => setRows((rs) => [...rs, { id: nextId.current++, key: "", value: "", askPerCall: false }])}
          className={buttonClass("secondary")}
        >
          {t("addVariable")}
        </button>
        <input type="hidden" name="variables" value={JSON.stringify(rows.map((r) => ({ key: r.key, value: r.value, askPerCall: r.askPerCall })))} />

        <label className="block max-w-sm space-y-1.5">
          <span className="text-sm font-medium text-stone-700">{t("timeZone")}</span>
          <select name="timeZone" value={tz} onChange={(e) => setTz(e.target.value)} className={inputClass}>
            {zones.map((z) => (
              <option key={z} value={z}>{z.replace(/_/g, " ")}</option>
            ))}
          </select>
          <span className="block text-xs text-stone-500">{t.rich("timeZoneHint", { code: (c) => <code>{c}</code> })}</span>
        </label>
      </div>
    </>
  );
}

function LabelRow({ htmlFor, label, insert }: { htmlFor: string; label: string; insert: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-2">
      <label htmlFor={htmlFor} className="text-sm font-medium text-stone-700">
        {label}
      </label>
      {insert}
    </div>
  );
}

/** A menu that types {{name}} at the cursor of a text field. */
function InsertVariable({ names, target }: { names: string[]; target: RefObject<TextField | null> }) {
  const t = useTranslations("agents");
  return (
    <select
      value=""
      aria-label={t("insertVariable")}
      onChange={(e) => {
        const el = target.current;
        if (!el || !e.target.value) return;
        el.setRangeText(`{{${e.target.value}}}`, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, "end");
        // setRangeText doesn't fire input events; let listeners see the new text.
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.focus();
      }}
      className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs font-medium text-stone-600 hover:bg-stone-50"
    >
      <option value="">{t("insertVariable")}</option>
      {names.map((n) => (
        <option key={n} value={n}>{`{{${n}}}`}</option>
      ))}
    </select>
  );
}

/** Every IANA zone the runtime knows, keeping the current one even if it doesn't list it. */
function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return all.includes(current) ? all : [current, ...all];
}
