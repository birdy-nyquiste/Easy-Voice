import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { config } from "@/lib/config";
import { getCurrentUser } from "@/server/auth";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { LoginForm } from "./login-form";
import { oauthErrorKey } from "./oauth-error";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getCurrentUser()) redirect("/dashboard");
  const { error } = await searchParams;
  const t = await getTranslations("login");
  const oauthError = error ? t(oauthErrorKey(error)) : undefined;
  return (
    <main className="relative flex min-h-screen items-center justify-center px-4">
      <div className="absolute right-4 top-4">
        <LocaleSwitcher />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div aria-hidden className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-stone-900 text-lg text-white">◉</div>
          <h1 className="text-xl font-semibold">{t("title")}</h1>
          <p className="mt-1 text-sm text-stone-500">{t("tagline")}</p>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
          <LoginForm google={config.google.enabled} oauthError={oauthError} />
        </div>
      </div>
    </main>
  );
}
