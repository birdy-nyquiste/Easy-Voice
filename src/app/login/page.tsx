import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { config } from "@/lib/config";
import { getCurrentUser } from "@/server/auth";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { buttonClass } from "@/components/ui";
import { LoginForm } from "./login-form";

const ERRORS = {
  google_disabled: "googleDisabled",
  google_state: "googleState",
  google_email: "googleEmail",
  google_failed: "googleFailed",
} as const;

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getCurrentUser()) redirect("/dashboard");
  const { error } = await searchParams;
  const t = await getTranslations("login");
  return (
    <main className="relative flex min-h-screen items-center justify-center px-4">
      <div className="absolute right-4 top-4">
        <LocaleSwitcher />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-stone-900 text-lg text-white">◉</div>
          <h1 className="text-xl font-semibold">{t("title")}</h1>
          <p className="mt-1 text-sm text-stone-500">{t("tagline")}</p>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
          {error && (
            <p className="mb-3 text-sm text-red-600">{t(error in ERRORS ? ERRORS[error as keyof typeof ERRORS] : "failed")}</p>
          )}
          {config.google.enabled && (
            <>
              <a href="/api/auth/google" className={`${buttonClass("secondary")} w-full`}>
                {t("google")}
              </a>
              <div className="my-4 flex items-center gap-3 text-xs text-stone-400">
                <span className="h-px flex-1 bg-stone-200" />
                {t("or")}
                <span className="h-px flex-1 bg-stone-200" />
              </div>
            </>
          )}
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
