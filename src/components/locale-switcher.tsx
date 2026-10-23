"use client";

import { useLocale, useTranslations } from "next-intl";
import { useOptimistic, useTransition } from "react";
import { setLocaleAction } from "@/app/locale-actions";
import { BCP47, LOCALES } from "@/i18n/locales";
import { focusRing } from "./ui";

/** Interface language picker. Each option is written in its own language, so it reads the same either way. */
export function LocaleSwitcher({ fill = false }: { fill?: boolean }) {
  const locale = useLocale();
  const t = useTranslations("localeSwitcher");
  const [pending, startTransition] = useTransition();
  // The chosen language shows at once; the page itself only changes once the switch is saved.
  const [shown, show] = useOptimistic<string>(locale);
  return (
    <select
      aria-label={t("label")}
      value={shown}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value;
        if (next === locale) return;
        startTransition(async () => {
          show(next);
          try {
            await setLocaleAction(next);
          } catch (err) {
            // A failed switch keeps the current language; thrown, it would replace the page with the error screen.
            console.error(err);
          }
        });
      }}
      className={`${fill ? "min-w-0 flex-1" : ""} cursor-pointer rounded-lg border-0 bg-stone-100 py-1 pl-2 pr-7 text-xs font-medium text-stone-700 transition-colors hover:text-stone-900 disabled:opacity-60 ${focusRing}`}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l} lang={BCP47[l]}>
          {t(l)}
        </option>
      ))}
    </select>
  );
}
