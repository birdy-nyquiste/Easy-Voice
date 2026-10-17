"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { setLocaleAction } from "@/app/locale-actions";
import { BCP47, LOCALES } from "@/i18n/locales";

/** English / 中文 toggle. Each option is written in its own language, so it reads the same either way. */
export function LocaleSwitcher({ fill = false }: { fill?: boolean }) {
  const locale = useLocale();
  const t = useTranslations("localeSwitcher");
  const [pending, startTransition] = useTransition();
  return (
    <div role="group" aria-label={t("label")} className={`${fill ? "flex flex-1" : "inline-flex"} shrink-0 rounded-lg bg-stone-100 p-0.5 text-xs`}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={BCP47[l]}
          aria-pressed={l === locale}
          disabled={pending}
          onClick={() => l !== locale && startTransition(() => setLocaleAction(l))}
          className={`${fill ? "flex-1" : ""} rounded-md px-2 py-1 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-stone-300 ${
            l === locale ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-900"
          }`}
        >
          {t(l)}
        </button>
      ))}
    </div>
  );
}
