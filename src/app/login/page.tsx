import { redirect } from "next/navigation";
import { config } from "@/lib/config";
import { getCurrentUser } from "@/server/auth";
import { buttonClass } from "@/components/ui";
import { LoginForm } from "./login-form";

const ERRORS: Record<string, string> = {
  google_disabled: "Google sign-in isn't configured.",
  google_state: "Google sign-in expired. Try again.",
  google_email: "Your Google account email isn't verified.",
  google_failed: "Google sign-in failed. Try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getCurrentUser()) redirect("/dashboard");
  const { error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-stone-900 text-lg text-white">◉</div>
          <h1 className="text-xl font-semibold">Sign in to Easy Voice</h1>
          <p className="mt-1 text-sm text-stone-500">Your AI agent, with its own phone number.</p>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
          {error && <p className="mb-3 text-sm text-red-600">{ERRORS[error] ?? "Sign-in failed."}</p>}
          {config.google.enabled && (
            <>
              <a href="/api/auth/google" className={`${buttonClass("secondary")} w-full`}>
                Continue with Google
              </a>
              <div className="my-4 flex items-center gap-3 text-xs text-stone-400">
                <span className="h-px flex-1 bg-stone-200" />
                or
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
