import { getTranslations } from "next-intl/server";

/**
 * Shown inside the sidebar layout while a page loads, so a click gives feedback at once: several pages
 * talk to Telnyx before they render.
 */
export default async function Loading() {
  const t = await getTranslations("common");
  return (
    <div role="status" className="animate-pulse space-y-6 motion-reduce:animate-none">
      <span className="sr-only">{t("loading")}</span>
      <div aria-hidden className="h-8 w-48 rounded-lg bg-stone-200" />
      <div aria-hidden className="space-y-3 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="h-4 w-32 rounded bg-stone-200" />
        <div className="h-4 w-full rounded bg-stone-100" />
        <div className="h-4 w-2/3 rounded bg-stone-100" />
      </div>
    </div>
  );
}
