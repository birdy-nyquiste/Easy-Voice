"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { setLocaleAction } from "@/app/locale-actions";
import { BCP47, LOCALES } from "@/i18n/locales";

/** Interface language picker. Each option is written in its own language, so it reads the same either way. */
export function LocaleSwitcher({ fill = false }: { fill?: boolean }) {
  const locale = useLocale();
  const t = useTranslations("localeSwitcher");
  const [pending, startTransition] = useTransition();
  return (
    <select
      aria-label={t("label")}
      value={locale}
      disabled={pending}
      onChange={(e) => e.target.value !== locale && startTransition(() => setLocaleAction(e.target.value))}
      className={`${fill ? "min-w-0 flex-1" : ""} cursor-pointer rounded-lg border-0 bg-stone-100 py-1 pl-2 pr-7 text-xs font-medium text-stone-700 outline-none transition-colors hover:text-stone-900 focus-visible:ring-2 focus-visible:ring-stone-300 disabled:opacity-60`}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l} lang={BCP47[l]}>
          {t(l)}
        </option>
      ))}
    </select>
  );
}
