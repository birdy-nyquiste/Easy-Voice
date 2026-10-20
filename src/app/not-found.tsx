import { getTranslations } from "next-intl/server";
import { ButtonLink } from "@/components/ui";

/** Replaces Next's built-in English 404, e.g. for another user's call or agent. */
export default async function NotFound() {
  const t = await getTranslations("errorPage");
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-semibold">{t("notFoundTitle")}</h1>
        <p className="mt-2 text-sm text-stone-500">{t("notFoundBody")}</p>
        <div className="mt-6">
          <ButtonLink href="/dashboard">{t("home")}</ButtonLink>
        </div>
      </div>
    </div>
  );
}
