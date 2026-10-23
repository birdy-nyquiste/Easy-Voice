"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { startTransition } from "react";
import { ButtonLink, buttonClass } from "@/components/ui";

/** Replaces Next's built-in English error screen when a page fails to render. */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("errorPage");
  const router = useRouter();
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-semibold">{t("errorTitle")}</h1>
        <p className="mt-2 text-sm text-stone-500">{t("errorBody")}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            // reset() alone re-renders the server response that failed; refresh fetches the page again.
            onClick={() =>
              startTransition(() => {
                router.refresh();
                reset();
              })
            }
            className={buttonClass()}
          >
            {t("retry")}
          </button>
          <ButtonLink href="/dashboard" variant="secondary">
            {t("home")}
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
